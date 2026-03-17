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
import type {
    CommentPubsubMessagePublication,
    CommentIpfsWithCidDefined,
    CommentsTableRow,
    CommentUpdatesRow,
    SubplebbitAuthor
} from "../../../../dist/node/publications/comment/types.js";
import type { PseudonymityAliasRow } from "../../../../dist/node/runtime/node/subplebbit/db-handler-types.js";

const remotePlebbitConfigs = getAvailablePlebbitConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true });

interface PerReplyContext {
    publisherPlebbit: Plebbit;
    subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    cleanup: () => Promise<void>;
    post?: Comment;
    firstReply?: Comment;
    secondReply?: Comment;
    firstNestedReply?: Comment;
    postDisplayName?: string;
    firstReplyDisplayName?: string;
    secondReplyDisplayName?: string;
    firstNestedReplyDisplayName?: string;
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
type SubplebbitAuthorRow = Partial<SubplebbitAuthor>;

// Type to access private methods for testing purposes
interface LocalSubplebbitWithPrivateMethods {
    storePublication: (args: { comment: CommentPubsubMessagePublication }) => Promise<{ cid: string }>;
    initDbHandlerIfNeeded: () => Promise<void>;
    _dbHandler: LocalSubplebbit["_dbHandler"];
}

describeSkipIfRpc('subplebbit.features.pseudonymityMode="per-reply"', () => {
    describe.concurrent("local anonymization", () => {
        let context: PerReplyContext;
        let authorSigner: SignerWithPublicKeyAddress;
        let otherSigner: SignerWithPublicKeyAddress;

        beforeAll(async () => {
            context = await createPerReplySubplebbit();
            authorSigner = await context.publisherPlebbit.createSigner();
            otherSigner = await context.publisherPlebbit.createSigner();
        });

        afterAll(async () => {
            await context.cleanup();
        });

        it('Spec: sub re-signs every new comment with a fresh anonymized author address when pseudonymityMode="per-reply"', async () => {
            const post = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

            const reply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, reply);

            const aliasRow = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(reply.cid) as AliasRow;
            expect(aliasRow).to.exist;
            expect(aliasRow.mode).to.equal("per-reply");
            expect(aliasRow.originalAuthorSignerPublicKey).to.equal(authorSigner.publicKey);

            const aliasSigner = await context.publisherPlebbit.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });
            const stored = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(reply.cid) as StoredComment;

            expect(stored?.author?.address).to.be.undefined;
            expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            expect(stored?.signature?.publicKey).to.not.equal(authorSigner.publicKey);
            expect(stored?.pseudonymityMode).to.equal("per-reply");
            await expectCommentCidToUseAlias(context.publisherPlebbit, reply.cid, aliasSigner);

            // Verify raw.pubsubMessageToPublish has pre-pseudonymization data
            expect(reply.raw.pubsubMessageToPublish?.signature?.publicKey).to.equal(authorSigner.publicKey);

            // Verify raw.comment has post-pseudonymization data
            expect(reply.raw.comment?.signature?.publicKey).to.equal(aliasSigner.publicKey);

            // Verify runtime comment has post-pseudonymization data
            expect(reply.author.address).to.equal(aliasSigner.address);
            expect(reply.signature?.publicKey).to.equal(aliasSigner.publicKey);

            await post.stop();
            await reply.stop();
        });
        it("Spec: same signer uses different anonymized author addresses for consecutive replies in the same post", async () => {
            const post = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

            const firstReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, firstReply);
            const secondReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, secondReply);

            const firstAlias = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                firstReply.cid
            ) as AliasRow;
            const secondAlias = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                secondReply.cid
            ) as AliasRow;

            expect(firstAlias).to.exist;
            expect(secondAlias).to.exist;
            expect(firstAlias.aliasPrivateKey).to.not.equal(secondAlias.aliasPrivateKey);

            const firstAliasSigner = await context.publisherPlebbit.createSigner({
                privateKey: firstAlias.aliasPrivateKey,
                type: "ed25519"
            });
            const secondAliasSigner = await context.publisherPlebbit.createSigner({
                privateKey: secondAlias.aliasPrivateKey,
                type: "ed25519"
            });

            expect(firstAliasSigner.address).to.not.equal(secondAliasSigner.address);
            await expectCommentCidToUseAlias(context.publisherPlebbit, firstReply.cid, firstAliasSigner);
            await expectCommentCidToUseAlias(context.publisherPlebbit, secondReply.cid, secondAliasSigner);
            await post.stop();
            await firstReply.stop();
            await secondReply.stop();
        });
        it("Spec: anonymized author addresses are never reused for the same signer across replies", async () => {
            const firstPost = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, firstPost);
            const firstReply = await publishRandomReply({
                parentComment: firstPost as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, firstReply);

            const secondPost = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, secondPost);
            const secondReply = await publishRandomReply({
                parentComment: secondPost as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, secondReply);

            const firstAlias = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                firstReply.cid
            ) as AliasRow;
            const secondAlias = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                secondReply.cid
            ) as AliasRow;

            expect(firstAlias).to.exist;
            expect(secondAlias).to.exist;
            expect(firstAlias.aliasPrivateKey).to.not.equal(secondAlias.aliasPrivateKey);

            const firstAliasSigner = await context.publisherPlebbit.createSigner({
                privateKey: firstAlias.aliasPrivateKey,
                type: "ed25519"
            });
            const secondAliasSigner = await context.publisherPlebbit.createSigner({
                privateKey: secondAlias.aliasPrivateKey,
                type: "ed25519"
            });

            expect(firstAliasSigner.address).to.not.equal(secondAliasSigner.address);
            await expectCommentCidToUseAlias(context.publisherPlebbit, firstReply.cid, firstAliasSigner);
            await expectCommentCidToUseAlias(context.publisherPlebbit, secondReply.cid, secondAliasSigner);
            await firstPost.stop();
            await secondPost.stop();
            await firstReply.stop();
            await secondReply.stop();
        });
        it("Spec: anonymized publication keeps author displayName while stripping wallets/avatar/flairs fields", async () => {
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

            const post = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

            const noisyReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    author: noisyAuthor,
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, noisyReply);

            const aliasRow = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                noisyReply.cid
            ) as AliasRow;
            const aliasSigner = await context.publisherPlebbit.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });

            const stored = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(noisyReply.cid) as StoredComment;
            expect(stored?.author).to.deep.equal({ displayName: noisyAuthor.displayName });
            expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            await expectCommentCidToUseAlias(context.publisherPlebbit, noisyReply.cid, aliasSigner);
            await post.stop();
            await noisyReply.stop();
        });

        it("Spec: anonymized publication omits author.previousCommentCid", async () => {
            const chainAuthor = await context.publisherPlebbit.createSigner();
            const previousPost = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: chainAuthor }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, previousPost);

            const post = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: chainAuthor }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

            const chainedReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: chainAuthor,
                    author: { previousCommentCid: previousPost.cid, address: chainAuthor.address }
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, chainedReply);

            const aliasRow = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                chainedReply.cid
            ) as AliasRow;
            const aliasSigner = await context.publisherPlebbit.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });
            const stored = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(chainedReply.cid) as StoredComment;
            expect(stored?.author?.previousCommentCid).to.be.undefined;
            expect(stored?.author?.address).to.be.undefined;
            await expectCommentCidToUseAlias(context.publisherPlebbit, chainedReply.cid, aliasSigner);
            await previousPost.stop();
            await post.stop();
            await chainedReply.stop();
        });

        it("Spec: comment edit signed by original author is accepted and re-signed with anonymized author key", async () => {
            const editSigner = await context.publisherPlebbit.createSigner();
            const post = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: editSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

            const editableReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: editSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, editableReply);

            const aliasRow = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                editableReply.cid
            ) as AliasRow;
            expect(aliasRow).to.exist;
            const aliasSigner = await context.publisherPlebbit.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });

            const editedContent = "Edited content - " + Date.now();
            const edit = await context.publisherPlebbit.createCommentEdit({
                subplebbitAddress: editableReply.subplebbitAddress,
                commentCid: editableReply.cid,
                content: editedContent,
                signer: editSigner
            });
            await publishWithExpectedResult({ publication: edit, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: context.subplebbit,
                predicate: async () =>
                    (
                        (context.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({ cid: editableReply.cid }) as
                            | StoredCommentUpdate
                            | undefined
                    )?.edit?.content === editedContent
            });

            const storedUpdate = (context.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                cid: editableReply.cid
            }) as StoredCommentUpdate;
            expect(storedUpdate?.edit?.content).to.equal(editedContent);
            expect(storedUpdate?.edit?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            const storedComment = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(editableReply.cid) as StoredComment;
            expect(storedComment?.author?.address).to.equal(aliasSigner.address);
            await expectCommentCidToUseAlias(context.publisherPlebbit, editableReply.cid, aliasSigner);
            await post.stop();
            await editableReply.stop();
        });

        it("Spec: comment edit is rejected when original author does not match stored anonymization mapping", async () => {
            const ownerSigner = await context.publisherPlebbit.createSigner();
            const intruderSigner = await context.publisherPlebbit.createSigner();
            const post = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: ownerSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

            const targetReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: ownerSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, targetReply);

            const badEdit = await context.publisherPlebbit.createCommentEdit({
                subplebbitAddress: targetReply.subplebbitAddress,
                commentCid: targetReply.cid,
                content: "Unauthorized edit " + Date.now(),
                signer: intruderSigner
            });
            await publishWithExpectedResult({
                publication: badEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_EDIT_CAN_NOT_EDIT_COMMENT_IF_NOT_ORIGINAL_AUTHOR
            });

            const storedUpdate = (context.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({ cid: targetReply.cid }) as
                | StoredCommentUpdate
                | undefined;
            expect(storedUpdate?.edit).to.be.undefined;
            await post.stop();
            await targetReply.stop();
        });

        it("Spec: anonymized comment.signature.publicKey differs from original author's signer publicKey", async () => {
            const freshSigner = await context.publisherPlebbit.createSigner();
            const post = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: freshSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

            const reply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: { signer: freshSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, reply);

            const stored = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(reply.cid) as StoredComment;
            const aliasRow = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(reply.cid) as AliasRow;
            expect(aliasRow).to.exist;
            const aliasSigner = await context.publisherPlebbit.createSigner({
                privateKey: aliasRow.aliasPrivateKey,
                type: "ed25519"
            });
            expect(stored?.signature?.publicKey).to.not.equal(freshSigner.publicKey);
            expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            expect(stored?.author?.address).to.be.undefined;
            await expectCommentCidToUseAlias(context.publisherPlebbit, reply.cid, aliasSigner);
            await post.stop();
            await reply.stop();
        });

        it("Spec: purging an anonymized comment removes its alias mapping", async () => {
            const purgeSigner = await context.publisherPlebbit.createSigner();
            const post = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: purgeSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

            const purgeTarget = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: purgeSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, purgeTarget);

            const aliasBeforePurge = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                purgeTarget.cid
            ) as AliasRow | undefined;
            expect(aliasBeforePurge).to.exist;

            await (context.subplebbit as LocalSubplebbit)._dbHandler.purgeComment(purgeTarget.cid);

            const aliasAfterPurge = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                purgeTarget.cid
            ) as AliasRow | undefined;
            expect(aliasAfterPurge).to.be.undefined;
            const commentAfterPurge = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(purgeTarget.cid) as
                | StoredComment
                | undefined;
            expect(commentAfterPurge).to.be.undefined;
            await post.stop();
            await purgeTarget.stop();
        });
        it("Spec: anonymized publication preserves original author fields in raw while public fields are stripped except displayName", async () => {
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

            const post = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

            const authoredReply = await context.publisherPlebbit.createComment({
                subplebbitAddress: context.subplebbit.address,
                signer: authorSigner,
                author: originalAuthor,
                content: originalContent,
                parentCid: post.cid,
                postCid: post.cid
            });
            await publishWithExpectedResult({ publication: authoredReply, expectedChallengeSuccess: true });
            expect(authoredReply.raw.pubsubMessageToPublish).to.be.ok;
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, authoredReply);

            const aliasRow = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                authoredReply.cid
            ) as AliasRow;
            expect(aliasRow).to.exist;
            const alias = await context.publisherPlebbit.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });
            const rawPubsub = () => authoredReply.raw.pubsubMessageToPublish;
            const expectOriginalFields = () => {
                expect(rawPubsub()?.author?.displayName).to.equal(originalAuthor.displayName);
                expect(rawPubsub()?.author?.wallets).to.deep.equal(originalAuthor.wallets);
                expect(rawPubsub()?.author?.flairs).to.deep.equal(originalAuthor.flairs);
                expect(rawPubsub()?.author?.previousCommentCid).to.equal(originalAuthor.previousCommentCid);
                expect(rawPubsub()?.content).to.equal(originalContent);
                expect(rawPubsub()?.signature?.publicKey).to.equal(authorSigner.publicKey);
            };

            const stored = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(authoredReply.cid) as StoredComment;
            expect(stored?.author?.address).to.be.undefined;
            expect(stored?.signature?.publicKey).to.equal(alias.publicKey);
            await expectCommentCidToUseAlias(context.publisherPlebbit, authoredReply.cid, alias);
            expectOriginalFields();

            // Verify raw.comment has alias (post-pseudonymization) data
            expect(authoredReply.raw.comment).to.be.ok;
            expect(authoredReply.raw.comment!.signature?.publicKey).to.equal(alias.publicKey);
            expect(authoredReply.raw.comment!.author?.displayName).to.equal(originalAuthor.displayName);
            expect(authoredReply.raw.comment!.author?.wallets).to.be.undefined;
            expect(authoredReply.raw.comment!.author?.flairs).to.be.undefined;
            expect(authoredReply.raw.comment!.author?.previousCommentCid).to.be.undefined;

            // Verify runtime comment has alias (post-pseudonymization) signature
            expect(authoredReply.signature?.publicKey).to.equal(alias.publicKey);

            await authoredReply.update();

            expect(authoredReply.author.address).to.equal(alias.address);
            expect(authoredReply.author.displayName).to.equal(originalAuthor.displayName);

            expectOriginalFields();

            await post.stop();
            await authoredReply.stop();
        });
        it("Spec: per-reply alias stays stable across multiple edits to the same reply but is unique per newly created reply", async () => {
            const post = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

            const firstReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, firstReply);

            const secondReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, secondReply);

            // Get alias for first reply
            const firstAlias = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                firstReply.cid
            ) as AliasRow;
            expect(firstAlias).to.exist;

            // Make multiple edits to the same reply
            const firstEditContent = "First edit - " + Date.now();
            const firstEdit = await context.publisherPlebbit.createCommentEdit({
                subplebbitAddress: firstReply.subplebbitAddress,
                commentCid: firstReply.cid,
                content: firstEditContent,
                signer: authorSigner
            });
            await publishWithExpectedResult({ publication: firstEdit, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: context.subplebbit,
                predicate: async () =>
                    (
                        (context.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({ cid: firstReply.cid }) as
                            | StoredCommentUpdate
                            | undefined
                    )?.edit?.content === firstEditContent
            });

            const secondEditContent = "Second edit - " + Date.now();
            const secondEdit = await context.publisherPlebbit.createCommentEdit({
                subplebbitAddress: firstReply.subplebbitAddress,
                commentCid: firstReply.cid,
                content: secondEditContent,
                signer: authorSigner
            });
            await publishWithExpectedResult({ publication: secondEdit, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: context.subplebbit,
                predicate: async () =>
                    (
                        (context.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({ cid: firstReply.cid }) as
                            | StoredCommentUpdate
                            | undefined
                    )?.edit?.content === secondEditContent
            });

            // Verify alias stayed the same across edits
            const aliasAfterEdits = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                firstReply.cid
            ) as AliasRow;
            expect(aliasAfterEdits).to.exist;
            expect(aliasAfterEdits.aliasPrivateKey).to.equal(firstAlias.aliasPrivateKey);

            // Verify different replies have different aliases
            const secondAlias = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                secondReply.cid
            ) as AliasRow;
            expect(secondAlias).to.exist;
            expect(secondAlias.aliasPrivateKey).to.not.equal(firstAlias.aliasPrivateKey);
            const aliasSigner = await context.publisherPlebbit.createSigner({
                privateKey: aliasAfterEdits.aliasPrivateKey,
                type: "ed25519"
            });
            const secondAliasSigner = await context.publisherPlebbit.createSigner({
                privateKey: secondAlias.aliasPrivateKey,
                type: "ed25519"
            });
            await expectCommentCidToUseAlias(context.publisherPlebbit, firstReply.cid, aliasSigner);
            await expectCommentCidToUseAlias(context.publisherPlebbit, secondReply.cid, secondAliasSigner);

            await post.stop();
            await firstReply.stop();
            await secondReply.stop();
        });

        it("Spec: same signer posting replies across different posts gets a fresh anonymized address for each reply (no cross-post reuse)", async () => {
            const firstPost = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, firstPost);

            const firstReply = await publishRandomReply({
                parentComment: firstPost as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, firstReply);

            const secondPost = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, secondPost);

            const secondReply = await publishRandomReply({
                parentComment: secondPost as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, secondReply);

            const firstAlias = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                firstReply.cid
            ) as AliasRow;
            const secondAlias = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                secondReply.cid
            ) as AliasRow;

            expect(firstAlias).to.exist;
            expect(secondAlias).to.exist;
            expect(firstAlias.aliasPrivateKey).to.not.equal(secondAlias.aliasPrivateKey);

            const firstAliasSigner = await context.publisherPlebbit.createSigner({
                privateKey: firstAlias.aliasPrivateKey,
                type: "ed25519"
            });
            const secondAliasSigner = await context.publisherPlebbit.createSigner({
                privateKey: secondAlias.aliasPrivateKey,
                type: "ed25519"
            });

            expect(firstAliasSigner.address).to.not.equal(secondAliasSigner.address);
            await expectCommentCidToUseAlias(context.publisherPlebbit, firstReply.cid, firstAliasSigner);
            await expectCommentCidToUseAlias(context.publisherPlebbit, secondReply.cid, secondAliasSigner);
            await firstPost.stop();
            await secondPost.stop();
            await firstReply.stop();
            await secondReply.stop();
        });

        it("Spec: author.address domains resolve and are anonymized per reply", async () => {
            const domainSigner = await context.publisherPlebbit.createSigner(signers[6]);
            const domainAddress = "plebbit.bso";
            const post = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: domainSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

            const resolvedAddress = await context.publisherPlebbit.resolveAuthorName({ address: domainAddress });
            expect(resolvedAddress).to.equal(domainSigner.address);

            const domainReply = await context.publisherPlebbit.createComment({
                subplebbitAddress: context.subplebbit.address,
                signer: domainSigner,
                author: { address: domainAddress, name: domainAddress, displayName: "Domain author" },
                content: "Domain anonymization content " + Date.now(),
                parentCid: post.cid,
                postCid: post.cid
            });
            await publishWithExpectedResult({ publication: domainReply, expectedChallengeSuccess: true });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, domainReply);

            const aliasRow = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                domainReply.cid
            ) as AliasRow;
            expect(aliasRow).to.exist;
            const aliasSigner = await context.publisherPlebbit.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });

            const stored = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(domainReply.cid) as StoredComment;
            expect(stored?.author?.address).to.be.undefined;
            expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            // Verify raw.pubsubMessageToPublish has pre-pseudonymization data
            expect(domainReply.raw.pubsubMessageToPublish?.author?.name).to.equal(domainAddress);
            expect(domainReply.raw.pubsubMessageToPublish?.signature?.publicKey).to.equal(domainSigner.publicKey);

            // Verify raw.comment has post-pseudonymization data
            expect(domainReply.raw.comment?.author?.name).to.be.undefined;
            expect(domainReply.raw.comment?.signature?.publicKey).to.equal(aliasSigner.publicKey);

            // Verify runtime comment has post-pseudonymization data
            expect(domainReply.author.address).to.equal(aliasSigner.address);
            expect(domainReply.signature?.publicKey).to.equal(aliasSigner.publicKey);

            await expectCommentCidToUseAlias(context.publisherPlebbit, domainReply.cid, aliasSigner);

            await post.stop();
            await domainReply.stop();
        });

        it("Spec: reply-to-reply (nested) anonymization creates a unique alias distinct from parent/post aliases and strips author metadata except displayName", async () => {
            const post = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

            const reply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, reply);

            const nestedReply = await publishRandomReply({
                parentComment: reply as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, nestedReply);

            const replyAlias = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(reply.cid) as AliasRow;
            const nestedAlias = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                nestedReply.cid
            ) as AliasRow;

            expect(replyAlias).to.exist;
            expect(nestedAlias).to.exist;
            expect(replyAlias.aliasPrivateKey).to.not.equal(nestedAlias.aliasPrivateKey);

            const replyAliasSigner = await context.publisherPlebbit.createSigner({
                privateKey: replyAlias.aliasPrivateKey,
                type: "ed25519"
            });
            const nestedAliasSigner = await context.publisherPlebbit.createSigner({
                privateKey: nestedAlias.aliasPrivateKey,
                type: "ed25519"
            });

            expect(replyAliasSigner.address).to.not.equal(nestedAliasSigner.address);

            const storedNested = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(nestedReply.cid) as StoredComment;
            expect(storedNested?.author?.address).to.equal(nestedAliasSigner.address);
            expect(storedNested?.author?.displayName).to.equal(nestedReply.author.displayName);
            expect(storedNested?.author?.wallets).to.be.undefined;
            await expectCommentCidToUseAlias(context.publisherPlebbit, nestedReply.cid, nestedAliasSigner);

            await post.stop();
            await reply.stop();
            await nestedReply.stop();
        });

        it("Spec: disabling pseudonymousAuthors stops anonymization for new replies without rewriting previously stored anonymized replies", async () => {
            const localContext = await createPerReplySubplebbit();
            const localAuthor = await localContext.publisherPlebbit.createSigner();

            let post: Comment | undefined;
            let anonymizedReply: Comment | undefined;
            let plainReply: Comment | undefined;
            try {
                // Create anonymized reply before disabling
                post = await publishRandomPost({
                    subplebbitAddress: localContext.subplebbit.address,
                    plebbit: localContext.publisherPlebbit,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, post);

                anonymizedReply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    plebbit: localContext.publisherPlebbit,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, anonymizedReply);

                const anonymizedAlias = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                    anonymizedReply.cid
                ) as AliasRow | undefined;
                expect(anonymizedAlias).to.exist;

                // Disable anonymization
                await localContext.subplebbit.edit({ features: { pseudonymityMode: undefined } });
                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () => localContext.subplebbit.features.pseudonymityMode === undefined
                });

                // Create new reply after disabling - should not be anonymized
                plainReply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    plebbit: localContext.publisherPlebbit,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, plainReply);

                const storedPlain = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryComment(plainReply.cid) as StoredComment;
                expect(storedPlain?.author?.address).to.equal(localAuthor.address);
                expect(storedPlain?.signature?.publicKey).to.equal(localAuthor.publicKey);

                const plainAlias = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                    plainReply.cid
                ) as AliasRow | undefined;
                expect(plainAlias).to.be.undefined;

                // Verify old anonymized reply is still anonymized
                const storedAnonymized = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryComment(
                    anonymizedReply.cid
                ) as StoredComment;
                expect(storedAnonymized?.author?.address).to.not.equal(localAuthor.address);
                expect(storedAnonymized?.signature?.publicKey).to.not.equal(localAuthor.publicKey);
                await expectCommentCidToUseAlias(localContext.publisherPlebbit, anonymizedReply.cid, {
                    address: storedAnonymized?.author?.address as string,
                    publicKey: storedAnonymized?.signature?.publicKey as string
                });
            } finally {
                await post?.stop();
                await anonymizedReply?.stop();
                await plainReply?.stop();
                await localContext.cleanup();
            }
        });

        it("Spec: purging one anonymized reply removes only that reply's alias mapping and leaves other replies (even from the same signer) intact", async () => {
            expect(context.subplebbit.features.pseudonymityMode).to.equal("per-reply");

            const post = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

            const firstReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, firstReply);

            const secondReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, secondReply);

            expect(context.subplebbit.features.pseudonymityMode).to.equal("per-reply");

            // Verify both aliases exist
            const firstAliasBefore = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                firstReply.cid
            ) as AliasRow;
            const secondAliasBefore = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                secondReply.cid
            ) as AliasRow;
            expect(firstAliasBefore).to.exist;
            expect(secondAliasBefore).to.exist;

            // Purge only the first reply
            await (context.subplebbit as LocalSubplebbit)._dbHandler.purgeComment(firstReply.cid);

            // Verify first reply and alias are gone
            const firstAliasAfter = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                firstReply.cid
            ) as AliasRow | undefined;
            const firstCommentAfter = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(firstReply.cid) as
                | StoredComment
                | undefined;
            expect(firstAliasAfter).to.be.undefined;
            expect(firstCommentAfter).to.be.undefined;

            // Verify second reply and alias are still there
            const secondAliasAfter = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                secondReply.cid
            ) as AliasRow;
            const secondCommentAfter = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(secondReply.cid) as StoredComment;
            expect(secondAliasAfter).to.exist;
            expect(secondCommentAfter).to.exist;
            expect(secondAliasAfter.aliasPrivateKey).to.equal(secondAliasBefore.aliasPrivateKey);

            await post.stop();
            await firstReply.stop();
            await secondReply.stop();
        });

        it("Spec: sub owner can resolve multiple anonymized addresses created by the same signer across several replies and map each back to the original signer", async () => {
            const post = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

            const firstReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, firstReply);

            const secondReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, secondReply);

            const thirdReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, thirdReply);

            // Verify all aliases exist and map to the same original signer
            const firstAlias = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                firstReply.cid
            ) as AliasRow;
            const secondAlias = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                secondReply.cid
            ) as AliasRow;
            const thirdAlias = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                thirdReply.cid
            ) as AliasRow;

            expect(firstAlias).to.exist;
            expect(secondAlias).to.exist;
            expect(thirdAlias).to.exist;

            expect(firstAlias.originalAuthorSignerPublicKey).to.equal(authorSigner.publicKey);
            expect(secondAlias.originalAuthorSignerPublicKey).to.equal(authorSigner.publicKey);
            expect(thirdAlias.originalAuthorSignerPublicKey).to.equal(authorSigner.publicKey);

            // Verify all aliases are unique
            expect(firstAlias.aliasPrivateKey).to.not.equal(secondAlias.aliasPrivateKey);
            expect(firstAlias.aliasPrivateKey).to.not.equal(thirdAlias.aliasPrivateKey);
            expect(secondAlias.aliasPrivateKey).to.not.equal(thirdAlias.aliasPrivateKey);

            await post.stop();
            await firstReply.stop();
            await secondReply.stop();
            await thirdReply.stop();
        });

        it("Spec: sub owner can resolve anonymized author addresses back to the original author address", async () => {
            const post = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

            const reply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: context.publisherPlebbit,
                commentProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, reply);

            const aliasRow = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(reply.cid) as AliasRow;
            expect(aliasRow).to.exist;
            expect(aliasRow.mode).to.equal("per-reply");
            expect(aliasRow.originalAuthorSignerPublicKey).to.equal(authorSigner.publicKey);

            const aliasSigner = await context.publisherPlebbit.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });
            expect(aliasSigner.address).to.be.a("string");
            expect(aliasSigner.address).to.not.equal(authorSigner.address);

            await post.stop();
            await reply.stop();
        });

        it("Spec: challengerequest emits full publication author.subplebbit fields without anonymization in per-reply mode", async () => {
            const localContext = await createPerReplySubplebbit();
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

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () =>
                        !!(localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(localAuthor.address)
                });

                const subplebbitAuthorBefore = (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(
                    localAuthor.address
                ) as SubplebbitAuthorRow;
                expect(subplebbitAuthorBefore, "expected subplebbit author to exist for original signer").to.be.ok;
                expect(subplebbitAuthorBefore.lastCommentCid).to.equal(seededPost.cid);
                expect(subplebbitAuthorBefore.firstCommentTimestamp).to.equal(seededPost.timestamp);
                expect(subplebbitAuthorBefore.postScore).to.equal(0);
                expect(subplebbitAuthorBefore.replyScore).to.equal(0);

                const challengeRequestPromise = new Promise<DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor>((resolve) =>
                    localContext.subplebbit.once("challengerequest", resolve)
                );
                const publication = await localContext.publisherPlebbit.createComment({
                    subplebbitAddress: localContext.subplebbit.address,
                    signer: localAuthor,
                    content: "per-reply challengerequest author.subplebbit check",
                    title: "per-reply challengerequest author.subplebbit check"
                });
                await publishWithExpectedResult({ publication: publication, expectedChallengeSuccess: true });

                const challengerequest = await challengeRequestPromise;
                expect(challengerequest.comment.author.address).to.equal(localAuthor.address);
                expect(challengerequest.comment.author.subplebbit).to.deep.equal(subplebbitAuthorBefore);
                expect(challengerequest.comment.author.subplebbit?.lastCommentCid).to.equal(seededPost.cid);
                expect(challengerequest.comment.author.subplebbit?.firstCommentTimestamp).to.equal(seededPost.timestamp);
                expect(challengerequest.comment.author.subplebbit?.postScore).to.equal(0);
                expect(challengerequest.comment.author.subplebbit?.replyScore).to.equal(0);

                await seededPost.stop();
                await publication.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.subplebbit.lastCommentCid equals the publication cid when pseudonymityMode is per-reply", async () => {
            const localContext = await createPerReplySubplebbit();
            const localAuthor = await localContext.publisherPlebbit.createSigner();

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

                const postUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                const replyUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: reply.cid
                }) as StoredCommentUpdate;
                expect(postUpdate?.author?.subplebbit?.lastCommentCid).to.equal(post.cid);
                expect(replyUpdate?.author?.subplebbit?.lastCommentCid).to.equal(reply.cid);

                await post.stop();
                await reply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.subplebbit.banExpiresAt rejects publications and only surfaces on the specific banned comment when pseudonymityMode is per-reply", async () => {
            const localContext = await createPerReplySubplebbit();
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

                const firstReply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    plebbit: localContext.publisherPlebbit,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, firstReply);

                const secondReply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    plebbit: localContext.publisherPlebbit,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, secondReply);

                const banExpiresAt = timestamp() + 60;
                const banModeration = await localContext.publisherPlebbit.createCommentModeration({
                    subplebbitAddress: localContext.subplebbit.address,
                    commentCid: firstReply.cid,
                    commentModeration: { author: { banExpiresAt }, reason: "ban for per-reply test" },
                    signer: moderator
                });
                await publishWithExpectedResult({ publication: banModeration, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () =>
                        (
                            (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(localAuthor.address) as
                                | SubplebbitAuthorRow
                                | undefined
                        )?.banExpiresAt === banExpiresAt
                });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () => {
                        const firstUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: firstReply.cid
                        }) as StoredCommentUpdate | undefined;
                        return firstUpdate?.author?.subplebbit?.banExpiresAt === banExpiresAt;
                    }
                });

                const secondUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: secondReply.cid
                }) as StoredCommentUpdate | undefined;
                expect(secondUpdate?.author?.subplebbit?.banExpiresAt).to.be.undefined;

                const blockedReply = await localContext.publisherPlebbit.createComment({
                    subplebbitAddress: localContext.subplebbit.address,
                    signer: localAuthor,
                    parentCid: post.cid,
                    postCid: post.cid,
                    content: "should be blocked"
                });
                await publishWithExpectedResult({
                    publication: blockedReply,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_AUTHOR_IS_BANNED
                });

                await post.stop();
                await firstReply.stop();
                await secondReply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: banning an anonymized comment maps to original and alias author addresses in per-reply mode", async () => {
            const localContext = await createPerReplySubplebbit();
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

                const aliasRow = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                    reply.cid
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
                    commentCid: reply.cid,
                    commentModeration: { author: { banExpiresAt }, reason: "ban alias mapping test" },
                    signer: moderator
                });
                await publishWithExpectedResult({ publication: banModeration, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () => {
                        const originalAuthor = (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(
                            localAuthor.address
                        ) as SubplebbitAuthorRow | undefined;
                        const aliasAuthor = (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(
                            aliasSigner.address
                        ) as SubplebbitAuthorRow | undefined;
                        return originalAuthor?.banExpiresAt === banExpiresAt && aliasAuthor?.banExpiresAt === banExpiresAt;
                    }
                });

                const originalAuthor = (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(
                    localAuthor.address
                ) as SubplebbitAuthorRow;
                const aliasAuthor = (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(
                    aliasSigner.address
                ) as SubplebbitAuthorRow;
                expect(originalAuthor?.banExpiresAt).to.equal(banExpiresAt);
                expect(aliasAuthor?.banExpiresAt).to.equal(banExpiresAt);

                await post.stop();
                await reply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.subplebbit.postScore stays 0 when pseudonymityMode is per-reply even if author has post karma", async () => {
            const localContext = await createPerReplySubplebbit();
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
                        Boolean((localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({ cid: post.cid }))
                });

                const postUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                expect(postUpdate?.author?.subplebbit?.postScore).to.equal(0);

                await post.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.subplebbit.replyScore reflects that single reply's karma when pseudonymityMode is per-reply", async () => {
            const localContext = await createPerReplySubplebbit();
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

                // TODO publish upvote to post, and make sure its replyScore = 0
                const upvote = await localContext.publisherPlebbit.createVote({
                    subplebbitAddress: localContext.subplebbit.address,
                    commentCid: reply.cid,
                    vote: 1,
                    signer: voter
                });
                await publishWithExpectedResult({ publication: upvote, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () =>
                        (
                            (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({ cid: reply.cid }) as
                                | StoredCommentUpdate
                                | undefined
                        )?.author?.subplebbit?.replyScore === 1
                });

                const postUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                const replyUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: reply.cid
                }) as StoredCommentUpdate;
                expect(postUpdate?.author?.subplebbit?.replyScore).to.equal(0);
                expect(replyUpdate?.author?.subplebbit?.replyScore).to.equal(1);

                await post.stop();
                await reply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.subplebbit.replyScore is tracked per reply when pseudonymityMode is per-reply", async () => {
            const localContext = await createPerReplySubplebbit();
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

                const firstReply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    plebbit: localContext.publisherPlebbit,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, firstReply);

                const secondReply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    plebbit: localContext.publisherPlebbit,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, secondReply);

                const upvoteSecondReply = await localContext.publisherPlebbit.createVote({
                    subplebbitAddress: localContext.subplebbit.address,
                    commentCid: secondReply.cid,
                    vote: 1,
                    signer: voter
                });
                await publishWithExpectedResult({ publication: upvoteSecondReply, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () => {
                        const firstUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: firstReply.cid
                        }) as StoredCommentUpdate | undefined;
                        const secondUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: secondReply.cid
                        }) as StoredCommentUpdate | undefined;
                        return (
                            !!firstUpdate &&
                            secondUpdate?.author?.subplebbit?.replyScore === 1 &&
                            typeof firstUpdate?.author?.subplebbit?.replyScore === "number"
                        );
                    }
                });

                const postUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                const firstReplyUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: firstReply.cid
                }) as StoredCommentUpdate;
                const secondReplyUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: secondReply.cid
                }) as StoredCommentUpdate;

                expect(postUpdate?.author?.subplebbit?.replyScore).to.equal(0);
                expect(firstReplyUpdate?.author?.subplebbit?.replyScore).to.equal(0);
                expect(secondReplyUpdate?.author?.subplebbit?.replyScore).to.equal(1);

                await post.stop();
                await firstReply.stop();
                await secondReply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.subplebbit.firstCommentTimestamp is the reply timestamp when pseudonymityMode is per-reply", async () => {
            const localContext = await createPerReplySubplebbit();
            const localAuthor = await localContext.publisherPlebbit.createSigner();

            try {
                const post = await publishRandomPost({
                    subplebbitAddress: localContext.subplebbit.address,
                    plebbit: localContext.publisherPlebbit,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, post);

                const postUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                expect(postUpdate?.author?.subplebbit?.firstCommentTimestamp).to.equal(post.timestamp);

                const reply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    plebbit: localContext.publisherPlebbit,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, reply);
                const replyUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: reply.cid
                }) as StoredCommentUpdate;
                expect(replyUpdate?.author?.subplebbit?.firstCommentTimestamp).to.equal(reply.timestamp);

                await post.stop();
                await reply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.subplebbit in CommentUpdate does NOT include karma from original author's prior comments when pseudonymityMode is per-reply", async () => {
            // This test verifies that enabling pseudonymity mode doesn't leak prior karma into new aliases
            // 1. Author builds karma without pseudonymity mode
            // 2. Enable pseudonymity mode
            // 3. Author publishes new comment (gets an alias)
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
                await sub.edit({ features: { pseudonymityMode: "per-reply" } });
                await resolveWhenConditionIsTrue({
                    toUpdate: sub,
                    predicate: async () => sub.features?.pseudonymityMode === "per-reply"
                });

                // Step 3: Author publishes a new comment (gets an alias)
                const pseudonymousReply = await publishRandomReply({
                    parentComment: nonPseudonymousPost as CommentIpfsWithCidDefined,
                    plebbit: plebbit,
                    commentProps: {
                        signer: author
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(sub as LocalSubplebbit, pseudonymousReply);

                // Step 4: Verify the alias's CommentUpdate shows isolated karma (0), not original author's karma (1)
                const replyUpdate = (sub as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: pseudonymousReply.cid
                }) as StoredCommentUpdate;

                // The alias should have its own isolated karma, not the original author's karma
                expect(replyUpdate?.author?.subplebbit?.postScore).to.equal(0);
                expect(replyUpdate?.author?.subplebbit?.replyScore).to.equal(0);

                // Verify the alias is different from the original author
                const aliasRow = (sub as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(pseudonymousReply.cid);
                expect(aliasRow).to.exist;
                expect(aliasRow?.originalAuthorSignerPublicKey).to.equal(author.publicKey);

                // Double-check: original author's karma should still be 1
                const originalAuthorKarmaAfter = (sub as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                expect(originalAuthorKarmaAfter?.postScore).to.equal(1);

                await nonPseudonymousPost.stop();
                await pseudonymousReply.stop();
            } finally {
                await sub.stop();
                await plebbit.destroy();
            }
        });

        it("Spec: banning a reply in per-reply mode surfaces banExpiresAt on that reply and blocks further replies and posts", async () => {
            const localContext = await createPerReplySubplebbit();
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
                const firstReply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    plebbit: localContext.publisherPlebbit,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, firstReply);

                const secondReply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    plebbit: localContext.publisherPlebbit,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, secondReply);

                const banExpiresAt = timestamp() + 60;
                const banModeration = await localContext.publisherPlebbit.createCommentModeration({
                    subplebbitAddress: localContext.subplebbit.address,
                    commentCid: firstReply.cid,
                    commentModeration: { author: { banExpiresAt }, reason: "ban for per-reply test" },
                    signer: moderator
                });
                await publishWithExpectedResult({ publication: banModeration, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () => {
                        const update = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: firstReply.cid
                        }) as StoredCommentUpdate | undefined;
                        return update?.author?.subplebbit?.banExpiresAt === banExpiresAt;
                    }
                });

                const secondUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: secondReply.cid
                }) as StoredCommentUpdate | undefined;
                expect(secondUpdate?.author?.subplebbit?.banExpiresAt).to.be.undefined;

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () =>
                        (
                            (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(localAuthor.address) as
                                | SubplebbitAuthorRow
                                | undefined
                        )?.banExpiresAt === banExpiresAt
                });

                const blockedReply = await localContext.publisherPlebbit.createComment({
                    subplebbitAddress: localContext.subplebbit.address,
                    signer: localAuthor,
                    parentCid: post.cid,
                    postCid: post.cid,
                    content: "blocked after ban"
                });
                await publishWithExpectedResult({
                    publication: blockedReply,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_AUTHOR_IS_BANNED
                });

                const blockedPost = await localContext.publisherPlebbit.createComment({
                    subplebbitAddress: localContext.subplebbit.address,
                    signer: localAuthor,
                    title: "blocked post after ban",
                    content: "blocked post after ban"
                });
                await publishWithExpectedResult({
                    publication: blockedPost,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_AUTHOR_IS_BANNED
                });

                await post.stop();
                await firstReply.stop();
                await secondReply.stop();
            } finally {
                await localContext.cleanup();
            }
        });
    });

    describe.sequential("duplicate comment regression", () => {
        let context: PerReplyContext;
        let duplicateSigner: SignerWithPublicKeyAddress;

        const clonePublication = <T>(value: T): T => JSON.parse(JSON.stringify(value));

        beforeAll(async () => {
            context = await createPerReplySubplebbit();
            duplicateSigner = await context.publisherPlebbit.createSigner();
        });

        afterAll(async () => {
            await context.cleanup();
        });

        it("Spec: rejects duplicate post publication in per-reply pseudonymity mode", async () => {
            let originalPost: Comment | undefined;
            let duplicatePost: Comment | undefined;

            try {
                originalPost = await context.publisherPlebbit.createComment({
                    subplebbitAddress: context.subplebbit.address,
                    signer: duplicateSigner,
                    title: `duplicate-per-reply-title-${Date.now()}`,
                    content: `duplicate-per-reply-content-${Date.now()}`
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

        it("Spec: rejects duplicate reply publication in per-reply pseudonymity mode", async () => {
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
                    content: `duplicate-per-reply-reply-${Date.now()}`
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

    describe("remote loading with anonymized comments", () => {
        describe("preloaded pages", () => {
            let sharedContext: PerReplyContext;
            let signingAuthor: SignerWithPublicKeyAddress;
            let replyAliasSigner: SignerWithPublicKeyAddress;

            beforeAll(async () => {
                sharedContext = await createPerReplySubplebbit();
                signingAuthor = await sharedContext.publisherPlebbit.createSigner();

                // Create post and replies
                sharedContext.post = await publishRandomPost({
                    subplebbitAddress: sharedContext.subplebbit.address,
                    plebbit: sharedContext.publisherPlebbit,
                    postProps: {
                        signer: signingAuthor
                    }
                });
                sharedContext.postDisplayName = sharedContext.post.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(sharedContext.subplebbit as LocalSubplebbit, sharedContext.post);

                sharedContext.firstReply = await publishRandomReply({
                    parentComment: sharedContext.post as CommentIpfsWithCidDefined,
                    plebbit: sharedContext.publisherPlebbit,
                    commentProps: {
                        signer: signingAuthor
                    }
                });
                sharedContext.firstReplyDisplayName = sharedContext.firstReply.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(sharedContext.subplebbit as LocalSubplebbit, sharedContext.firstReply);

                sharedContext.secondReply = await publishRandomReply({
                    parentComment: sharedContext.post as CommentIpfsWithCidDefined,
                    plebbit: sharedContext.publisherPlebbit,
                    commentProps: {
                        signer: signingAuthor
                    }
                });
                sharedContext.secondReplyDisplayName = sharedContext.secondReply.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(sharedContext.subplebbit as LocalSubplebbit, sharedContext.secondReply);

                await waitTillPostInSubplebbitPages(sharedContext.post as CommentIpfsWithCidDefined, sharedContext.publisherPlebbit);
                await waitTillReplyInParentPages(
                    sharedContext.firstReply as Required<Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">>,
                    sharedContext.publisherPlebbit
                );
                await waitTillReplyInParentPages(
                    sharedContext.secondReply as Required<Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">>,
                    sharedContext.publisherPlebbit
                );

                // Get alias signer for verification
                const firstReplyAlias = (sharedContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                    sharedContext.firstReply.cid
                ) as AliasRow;
                expect(firstReplyAlias).to.exist;
                replyAliasSigner = await sharedContext.publisherPlebbit.createSigner({
                    privateKey: firstReplyAlias.aliasPrivateKey,
                    type: "ed25519"
                });
            });

            afterAll(async () => {
                await sharedContext?.post?.stop();
                await sharedContext?.firstReply?.stop();
                await sharedContext?.secondReply?.stop();
                await sharedContext?.cleanup();
            });

            remotePlebbitConfigs.forEach((config) => {
                describe(`${config.name} - preloaded`, () => {
                    let remotePlebbit: Plebbit;

                    beforeAll(async () => {
                        remotePlebbit = await config.plebbitInstancePromise();
                        await waitTillPostInSubplebbitPages(sharedContext.post as CommentIpfsWithCidDefined, remotePlebbit);
                        await waitTillReplyInParentPages(
                            sharedContext.firstReply as Required<
                                Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">
                            >,
                            remotePlebbit
                        );
                        await waitTillReplyInParentPages(
                            sharedContext.secondReply as Required<
                                Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">
                            >,
                            remotePlebbit
                        );
                    });

                    afterAll(async () => {
                        await remotePlebbit?.destroy();
                    });

                    it("Spec: loads preloaded pages with anonymized posts/replies without failing verification", async () => {
                        const remoteSubplebbit = await remotePlebbit.getSubplebbit({ address: sharedContext.subplebbit.address });
                        expect(Object.keys(remoteSubplebbit.posts.pages).length).to.be.greaterThan(0);

                        // Check posts in pages (posts are not anonymized, only replies are)
                        for (const sortName of Object.keys(remoteSubplebbit.posts.pages)) {
                            const page = remoteSubplebbit.posts.pages[sortName];
                            const postInPage = page?.comments?.find((c) => c.cid === sharedContext.post?.cid);
                            if (postInPage) {
                                expect(postInPage?.author?.address).to.equal(sharedContext.post?.author.address);
                                expect(postInPage?.signature?.publicKey).to.equal(sharedContext.post?.signature.publicKey);
                                expect(postInPage?.pseudonymityMode).to.equal("per-reply");
                            }
                        }

                        // Check replies in pages - they should be anonymized
                        const remoteParent = await remotePlebbit.getComment({ cid: sharedContext.post!.cid });
                        await remoteParent.update();
                        await resolveWhenConditionIsTrue({
                            toUpdate: remoteParent,
                            predicate: async () => typeof remoteParent.updatedAt === "number"
                        });

                        const firstReplyInPreloaded = remoteParent.replies.pages?.best?.comments?.find(
                            (c) => c.cid === sharedContext.firstReply?.cid
                        );
                        if (firstReplyInPreloaded) {
                            expect(firstReplyInPreloaded.author.address).to.not.equal(signingAuthor.address);
                            expect(firstReplyInPreloaded.author.displayName).to.equal(sharedContext.firstReplyDisplayName);
                            expect(firstReplyInPreloaded.author.wallets).to.be.undefined;
                            expect(firstReplyInPreloaded.signature.publicKey).to.not.equal(signingAuthor.publicKey);
                            expect(firstReplyInPreloaded.pseudonymityMode).to.equal("per-reply");
                        }

                        await remoteParent.stop();
                    });

                    it("Spec: getComment on an anonymized reply keeps displayName while stripping other author fields and keeps the per-reply alias stable after comment.update()", async () => {
                        const remoteReply = await remotePlebbit.getComment({ cid: sharedContext.firstReply!.cid });
                        await remoteReply.update();
                        await resolveWhenConditionIsTrue({
                            toUpdate: remoteReply,
                            predicate: async () => typeof remoteReply.updatedAt === "number"
                        });

                        expect(remoteReply.author.address).to.not.equal(signingAuthor.address);
                        expect(remoteReply.author.displayName).to.equal(sharedContext.firstReplyDisplayName);
                        expect(remoteReply.author.wallets).to.be.undefined;
                        expect(remoteReply.author.flairs).to.be.undefined;
                        expect(remoteReply.signature.publicKey).to.not.equal(signingAuthor.publicKey);
                        expect(remoteReply.pseudonymityMode).to.equal("per-reply");

                        // Update again to verify alias stability
                        await remoteReply.update();
                        expect(remoteReply.author.address).to.not.equal(signingAuthor.address);
                        expect(remoteReply.signature.publicKey).to.not.equal(signingAuthor.publicKey);

                        await remoteReply.stop();
                    });
                });
            });
        });

        describe("paginated pages", () => {
            let paginatedContext: PerReplyContext;
            let paginatedSigningAuthor: SignerWithPublicKeyAddress;
            let firstReplyAliasSigner: SignerWithPublicKeyAddress;
            let secondReplyAliasSigner: SignerWithPublicKeyAddress;
            let paginatedForcedChunkingCleanup: (() => void) | undefined;
            let nestedForcedChunkingCleanup: (() => void) | undefined;

            beforeAll(async () => {
                paginatedContext = await createPerReplySubplebbit();
                paginatedSigningAuthor = await paginatedContext.publisherPlebbit.createSigner();

                // Create post and multiple replies for pagination testing
                paginatedContext.post = await publishRandomPost({
                    subplebbitAddress: paginatedContext.subplebbit.address,
                    plebbit: paginatedContext.publisherPlebbit,
                    postProps: {
                        signer: paginatedSigningAuthor
                    }
                });
                paginatedContext.postDisplayName = paginatedContext.post.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(paginatedContext.subplebbit as LocalSubplebbit, paginatedContext.post);

                paginatedContext.firstReply = await publishRandomReply({
                    parentComment: paginatedContext.post as CommentIpfsWithCidDefined,
                    plebbit: paginatedContext.publisherPlebbit,
                    commentProps: {
                        signer: paginatedSigningAuthor
                    }
                });
                paginatedContext.firstReplyDisplayName = paginatedContext.firstReply.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(paginatedContext.subplebbit as LocalSubplebbit, paginatedContext.firstReply);

                paginatedContext.secondReply = await publishRandomReply({
                    parentComment: paginatedContext.post as CommentIpfsWithCidDefined,
                    plebbit: paginatedContext.publisherPlebbit,
                    commentProps: {
                        signer: paginatedSigningAuthor
                    }
                });
                paginatedContext.secondReplyDisplayName = paginatedContext.secondReply.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(
                    paginatedContext.subplebbit as LocalSubplebbit,
                    paginatedContext.secondReply
                );

                // Create nested replies
                paginatedContext.firstNestedReply = await publishRandomReply({
                    parentComment: paginatedContext.firstReply as CommentIpfsWithCidDefined,
                    plebbit: paginatedContext.publisherPlebbit,
                    commentProps: {
                        signer: paginatedSigningAuthor
                    }
                });
                paginatedContext.firstNestedReplyDisplayName = paginatedContext.firstNestedReply.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(
                    paginatedContext.subplebbit as LocalSubplebbit,
                    paginatedContext.firstNestedReply
                );
                const { cleanup } = await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
                    subplebbit: paginatedContext.subplebbit,
                    parentComment: paginatedContext.post
                });
                paginatedForcedChunkingCleanup = cleanup;
                const { cleanup: cleanupNested } = await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
                    subplebbit: paginatedContext.subplebbit,
                    parentComment: paginatedContext.firstReply
                });
                nestedForcedChunkingCleanup = cleanupNested;

                await forceSubplebbitToGenerateAllPostsPages(paginatedContext.subplebbit as LocalSubplebbit);
                await waitTillPostInSubplebbitPages(paginatedContext.post as CommentIpfsWithCidDefined, paginatedContext.publisherPlebbit);
                await waitTillReplyInParentPages(
                    paginatedContext.firstReply as Required<Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">>,
                    paginatedContext.publisherPlebbit
                );
                await waitTillReplyInParentPages(
                    paginatedContext.secondReply as Required<Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">>,
                    paginatedContext.publisherPlebbit
                );
                await waitTillReplyInParentPages(
                    paginatedContext.firstNestedReply as Required<
                        Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">
                    >,
                    paginatedContext.publisherPlebbit
                );

                // Get alias signers for verification
                const firstReplyAlias = (paginatedContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                    paginatedContext.firstReply.cid
                ) as AliasRow;
                const secondReplyAlias = (paginatedContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                    paginatedContext.secondReply.cid
                ) as AliasRow;
                const nestedReplyAlias = (paginatedContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                    paginatedContext.firstNestedReply.cid
                ) as AliasRow;

                expect(firstReplyAlias).to.exist;
                expect(secondReplyAlias).to.exist;
                expect(nestedReplyAlias).to.exist;

                firstReplyAliasSigner = await paginatedContext.publisherPlebbit.createSigner({
                    privateKey: firstReplyAlias.aliasPrivateKey,
                    type: "ed25519"
                });
                secondReplyAliasSigner = await paginatedContext.publisherPlebbit.createSigner({
                    privateKey: secondReplyAlias.aliasPrivateKey,
                    type: "ed25519"
                });
            });

            afterAll(async () => {
                await paginatedContext?.post?.stop();
                await paginatedContext?.firstReply?.stop();
                await paginatedContext?.secondReply?.stop();
                await paginatedContext?.firstNestedReply?.stop();
                await paginatedForcedChunkingCleanup?.();
                await nestedForcedChunkingCleanup?.();
                await paginatedContext?.cleanup();
            });

            remotePlebbitConfigs.forEach((config) => {
                describe(`${config.name} - paginated`, () => {
                    let remotePlebbit: Plebbit;

                    beforeAll(async () => {
                        remotePlebbit = await config.plebbitInstancePromise();
                        await waitTillPostInSubplebbitPages(paginatedContext.post as CommentIpfsWithCidDefined, remotePlebbit);
                        await waitTillReplyInParentPages(
                            paginatedContext.firstReply as Required<
                                Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">
                            >,
                            remotePlebbit
                        );
                        await waitTillReplyInParentPages(
                            paginatedContext.secondReply as Required<
                                Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">
                            >,
                            remotePlebbit
                        );
                        await waitTillReplyInParentPages(
                            paginatedContext.firstNestedReply as Required<
                                Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">
                            >,
                            remotePlebbit
                        );
                    });

                    afterAll(async () => {
                        await remotePlebbit.destroy();
                    });

                    it.sequential("Spec: subplebbit.posts.getPage({ cid }) loads a page with anonymized comments", async () => {
                        const remoteSubplebbit = await remotePlebbit.getSubplebbit({ address: paginatedContext.subplebbit.address });
                        expect(Object.keys(remoteSubplebbit.posts.pageCids).length).to.be.greaterThan(0);

                        for (const firstPageCid of Object.values(remoteSubplebbit.posts.pageCids)) {
                            let currentCid: string | undefined = firstPageCid;
                            let found = false;
                            while (currentCid && !found) {
                                const page = await remoteSubplebbit.posts.getPage({ cid: currentCid });
                                const postInPage = page.comments.find((c) => c.cid === paginatedContext.post?.cid);
                                if (postInPage) {
                                    // Posts are not anonymized, only replies are
                                    expect(postInPage?.author?.address).to.equal(paginatedContext.post?.author.address);
                                    expect(postInPage?.signature?.publicKey).to.equal(paginatedContext.post?.signature.publicKey);
                                    found = true;
                                } else {
                                    currentCid = page.nextCid;
                                }
                            }
                            expect(found, "expected paginated post to appear in one of the pages").to.be.true;
                        }
                    });

                    it("Spec: comment.replies.getPage({ cid }) loads a page with anonymized replies", async () => {
                        const remoteParent = await remotePlebbit.getComment({ cid: paginatedContext.post!.cid });
                        await remoteParent.update();
                        await waitTillReplyInParentPagesInstance(
                            paginatedContext.firstReply as Required<
                                Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">
                            >,
                            remoteParent
                        );
                        expect(
                            Object.keys(remoteParent.replies.pageCids || {}),
                            "expected replies.pageCids to be populated for paginated replies"
                        ).to.not.be.empty;
                        const replyPageCid = Object.values(remoteParent.replies.pageCids || {})[0];
                        expect(replyPageCid, "expected a replies page cid after forcing pagination").to.be.ok;
                        const repliesPage = await remoteParent.replies.getPage({ cid: replyPageCid });
                        const firstReplyEntryInPage = repliesPage.comments.find((c) => c.cid === paginatedContext.firstReply?.cid);
                        const secondReplyEntryInPage = repliesPage.comments.find((c) => c.cid === paginatedContext.secondReply?.cid);

                        expect(firstReplyEntryInPage?.author?.address).to.not.equal(paginatedSigningAuthor.address);
                        expect(firstReplyEntryInPage?.author?.displayName).to.equal(paginatedContext.firstReplyDisplayName);
                        expect(firstReplyEntryInPage?.signature?.publicKey).to.not.equal(paginatedSigningAuthor.publicKey);

                        expect(secondReplyEntryInPage?.author?.address).to.not.equal(paginatedSigningAuthor.address);
                        expect(secondReplyEntryInPage?.author?.displayName).to.equal(paginatedContext.secondReplyDisplayName);
                        expect(secondReplyEntryInPage?.signature?.publicKey).to.not.equal(paginatedSigningAuthor.publicKey);

                        // Verify replies have different anonymized addresses
                        expect(firstReplyEntryInPage?.author?.address).to.not.equal(secondReplyEntryInPage?.author?.address);
                        await remoteParent.stop();
                    });

                    it("Spec: paginated replies from the same signer show distinct anonymized addresses per reply with valid signatures across pages", async () => {
                        const remoteParent = await remotePlebbit.getComment({ cid: paginatedContext.post!.cid });
                        await remoteParent.update();
                        await waitTillReplyInParentPagesInstance(
                            paginatedContext.firstReply as Required<
                                Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">
                            >,
                            remoteParent
                        );
                        await waitTillReplyInParentPagesInstance(
                            paginatedContext.secondReply as Required<
                                Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">
                            >,
                            remoteParent
                        );

                        const seenReplyAddresses = new Map<string, { address: string; publicKey: string }>();
                        const replyPageCids = remoteParent.replies.pageCids || {};
                        expect(Object.keys(replyPageCids), "expected replies.pageCids to be populated").to.not.be.empty;
                        for (const firstPageCid of Object.values(replyPageCids)) {
                            let currentCid: string | undefined = firstPageCid;
                            while (currentCid) {
                                const page = await remoteParent.replies.getPage({ cid: currentCid });
                                page.comments.forEach((comment) => {
                                    if (comment.cid === paginatedContext.firstReply?.cid) {
                                        seenReplyAddresses.set(comment.cid, {
                                            address: comment.author.address,
                                            publicKey: comment.signature.publicKey
                                        });
                                    }
                                    if (comment.cid === paginatedContext.secondReply?.cid) {
                                        seenReplyAddresses.set(comment.cid, {
                                            address: comment.author.address,
                                            publicKey: comment.signature.publicKey
                                        });
                                    }
                                });
                                if (
                                    page.nextCid &&
                                    (!seenReplyAddresses.has(paginatedContext.firstReply!.cid) ||
                                        !seenReplyAddresses.has(paginatedContext.secondReply!.cid))
                                )
                                    currentCid = page.nextCid;
                                else break;
                            }
                        }

                        expect(seenReplyAddresses.has(paginatedContext.firstReply!.cid)).to.be.true;
                        expect(seenReplyAddresses.has(paginatedContext.secondReply!.cid)).to.be.true;

                        const firstEntry = seenReplyAddresses.get(paginatedContext.firstReply!.cid)!;
                        const secondEntry = seenReplyAddresses.get(paginatedContext.secondReply!.cid)!;

                        expect(firstEntry.address).to.not.equal(paginatedSigningAuthor.address);
                        expect(secondEntry.address).to.not.equal(paginatedSigningAuthor.address);
                        expect(firstEntry.address).to.not.equal(secondEntry.address);
                        expect(firstEntry.publicKey).to.not.equal(secondEntry.publicKey);
                        await remoteParent.stop();
                    });

                    it("Spec: replies-to-replies fetched via comment.replies.getPage remain anonymized and verifiable (distinct per reply)", async () => {
                        const remoteParentReply = await remotePlebbit.getComment({ cid: paginatedContext.firstReply!.cid });
                        await remoteParentReply.update();
                        await waitTillReplyInParentPagesInstance(
                            paginatedContext.firstNestedReply as Required<
                                Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">
                            >,
                            remoteParentReply
                        );

                        const nestedReplyPageCid = Object.values(remoteParentReply.replies.pageCids || {})[0];
                        expect(Object.keys(remoteParentReply.replies.pageCids || {}), "expected nested replies.pageCids to be populated").to
                            .not.be.empty;
                        expect(nestedReplyPageCid, "expected a nested replies page cid after forcing pagination").to.be.ok;
                        const nestedRepliesPage = await remoteParentReply.replies.getPage({ cid: nestedReplyPageCid });
                        const nestedReplyEntryInPage = nestedRepliesPage.comments.find(
                            (c) => c.cid === paginatedContext.firstNestedReply?.cid
                        );

                        expect(nestedReplyEntryInPage?.author?.address).to.not.equal(paginatedSigningAuthor.address);
                        expect(nestedReplyEntryInPage?.author?.displayName).to.equal(paginatedContext.firstNestedReplyDisplayName);
                        expect(nestedReplyEntryInPage?.signature?.publicKey).to.not.equal(paginatedSigningAuthor.publicKey);

                        // Verify nested reply has different anonymized address from parent replies
                        expect(nestedReplyEntryInPage?.author?.address).to.not.equal(firstReplyAliasSigner.address);
                        expect(nestedReplyEntryInPage?.author?.address).to.not.equal(secondReplyAliasSigner.address);
                        await remoteParentReply.stop();
                    });
                });
            });
        });
    });

    describe.sequential("mod exclusion from pseudonymization", () => {
        let modContext: PerReplyContext;
        let modSigner: SignerWithPublicKeyAddress;
        let regularSigner: SignerWithPublicKeyAddress;

        beforeAll(async () => {
            modContext = await createPerReplySubplebbit();
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

        it("Spec: mod comment is NOT pseudonymized in per-reply mode", async () => {
            const modPost = await publishRandomPost({
                subplebbitAddress: modContext.subplebbit.address,
                plebbit: modContext.publisherPlebbit,
                postProps: { signer: modSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(modContext.subplebbit as LocalSubplebbit, modPost);

            const stored = (modContext.subplebbit as LocalSubplebbit)._dbHandler.queryComment(modPost.cid) as StoredComment;
            expect(stored?.author?.address).to.be.undefined;
            expect(stored?.signature?.publicKey).to.equal(modSigner.publicKey);
            expect(stored?.pseudonymityMode).to.be.undefined;

            const aliasRow = (modContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(modPost.cid);
            expect(aliasRow).to.be.undefined;

            await modPost.stop();
        });

        it("Spec: non-mod is still pseudonymized alongside mod in per-reply mode", async () => {
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

            const aliasRow = (modContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                regularPost.cid
            ) as AliasRow;
            expect(aliasRow).to.exist;
            expect(aliasRow.mode).to.equal("per-reply");

            await modPost.stop();
            await regularPost.stop();
        });

        it("Spec: mod comment edit uses real key in per-reply mode", async () => {
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

    describe.sequential("Spec: existing replies keep original pseudonymityMode while new replies follow current mode", () => {
        it("Spec: per-reply replies stay per-reply after switching to per-author", async () => {
            await assertPseudonymityModeTransition({ initialMode: "per-reply", nextMode: "per-author" });
        });

        it("Spec: per-reply replies stay per-reply after switching to per-post", async () => {
            await assertPseudonymityModeTransition({ initialMode: "per-reply", nextMode: "per-post" });
        });
    });
});

async function expectCommentCidToUseAlias(
    plebbit: Plebbit,
    cid: string,
    aliasSigner: { address: string; publicKey: string }
): Promise<void> {
    const fetched = JSON.parse(await plebbit.fetchCid({ cid })) as {
        author?: { address?: string };
        signature?: { publicKey?: string };
        pseudonymityMode?: string;
    };
    expect(fetched?.author?.address).to.be.undefined;
    expect(fetched?.signature?.publicKey).to.equal(aliasSigner.publicKey);
    expect(fetched?.pseudonymityMode).to.equal("per-reply");
}

const PROTOCOL_VERSION = "1.0.0";

async function assertPseudonymityModeTransition({ initialMode, nextMode }: { initialMode: string; nextMode: string }): Promise<void> {
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
}): Promise<CommentPubsubMessagePublication> {
    const base = {
        signer,
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
}): Promise<CommentPubsubMessagePublication> {
    const base = {
        signer,
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

async function ensureSubplebbitDbReady(subplebbit: LocalSubplebbit): Promise<void> {
    if (typeof (subplebbit as unknown as LocalSubplebbitWithPrivateMethods).initDbHandlerIfNeeded === "function") {
        await (subplebbit as unknown as LocalSubplebbitWithPrivateMethods).initDbHandlerIfNeeded();
    }
    await subplebbit._dbHandler.initDbIfNeeded({ fileMustExist: false });
}

function expectStoredCommentToUseAlias(
    dbHandler: LocalSubplebbit["_dbHandler"],
    cid: string,
    aliasSigner: SignerWithPublicKeyAddress
): void {
    const stored = dbHandler.queryComment(cid) as StoredComment;
    expect(stored?.author?.address).to.be.undefined;
    expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
}

async function createAnonymityTransitionContext(initialMode: string): Promise<AnonymityTransitionContext> {
    const plebbit = await mockPlebbit();
    const subplebbit = await createSubWithNoChallenge({}, plebbit);
    await subplebbit.edit({ features: { pseudonymityMode: initialMode as "per-author" | "per-post" | "per-reply" } });
    await (subplebbit as LocalSubplebbit)._dbHandler.initDbIfNeeded({ fileMustExist: false });
    await (subplebbit as LocalSubplebbit)._dbHandler.createOrMigrateTablesIfNeeded();
    return {
        subplebbit,
        dbHandler: (subplebbit as LocalSubplebbit)._dbHandler,
        plebbit,
        subplebbitAddress: subplebbit.address,
        cleanup: async () => {
            await subplebbit.delete();
            await plebbit.destroy();
        }
    };
}

async function createPerReplySubplebbit(): Promise<PerReplyContext> {
    const publisherPlebbit = await mockPlebbit();
    const subplebbit = await createSubWithNoChallenge({}, publisherPlebbit);
    await subplebbit.edit({ features: { pseudonymityMode: "per-reply" } });
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
    if (!comment.cid) throw new Error("waitForStoredCommentUpdateWithAssertions expects comment.cid to be defined");
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
    if (!cid) throw new Error("waitForStoredCommentUpdate requires a cid");
    const timeoutMs = 60000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const stored = subplebbit._dbHandler.queryStoredCommentUpdate({ cid }) as StoredCommentUpdate | undefined;
        if (stored) return stored;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for stored comment update for ${cid}`);
}

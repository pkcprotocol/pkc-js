import { describe, it, beforeAll, afterAll } from "vitest";
import {
    createSubWithNoChallenge,
    getAvailablePKCConfigsToTestAgainst,
    mockPKC,
    publishRandomPost,
    publishRandomReply,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    forceCommunityToGenerateAllPostsPages,
    forceLocalSubPagesToAlwaysGenerateMultipleChunks,
    waitTillPostInCommunityPages,
    waitTillReplyInParentPages,
    waitTillReplyInParentPagesInstance
} from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { messages } from "../../../../dist/node/errors.js";
import { timestamp } from "../../../../dist/node/util.js";
import { createSigner, SignerWithPublicKeyAddress } from "../../../../dist/node/signer/index.js";
import { signComment } from "../../../../dist/node/signer/signatures.js";
import signers from "../../../fixtures/signers.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "../../../../dist/node/pubsub-messages/types.js";
import type {
    CommentPubsubMessagePublication,
    CommentIpfsWithCidDefined,
    CommentsTableRow,
    CommentUpdatesRow,
    CommunityAuthor
} from "../../../../dist/node/publications/comment/types.js";
import type { PseudonymityAliasRow } from "../../../../dist/node/runtime/node/community/db-handler-types.js";

const remotePKCConfigs = getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true });

interface PerReplyContext {
    publisherPKC: PKC;
    community: LocalCommunity | RpcLocalCommunity;
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
    community: LocalCommunity | RpcLocalCommunity;
    dbHandler: LocalCommunity["_dbHandler"];
    pkc: PKC;
    communityAddress: string;
    cleanup: () => Promise<void>;
}

type AliasRow = Pick<PseudonymityAliasRow, "mode" | "aliasPrivateKey" | "originalAuthorPublicKey">;
type StoredCommentUpdate = Pick<
    CommentUpdatesRow,
    "cid" | "updatedAt" | "replyCount" | "protocolVersion" | "signature" | "edit" | "author"
>;
type StoredComment = Pick<CommentsTableRow, "cid" | "author" | "signature" | "parentCid" | "pseudonymityMode">;
type CommunityAuthorRow = Partial<CommunityAuthor>;

// Type to access private methods for testing purposes
interface LocalCommunityWithPrivateMethods {
    storePublication: (args: { comment: CommentPubsubMessagePublication }) => Promise<{ cid: string }>;
    initDbHandlerIfNeeded: () => Promise<void>;
    _dbHandler: LocalCommunity["_dbHandler"];
}

describeSkipIfRpc('community.features.pseudonymityMode="per-reply"', () => {
    describe.concurrent("local anonymization", () => {
        let context: PerReplyContext;
        let authorSigner: SignerWithPublicKeyAddress;
        let otherSigner: SignerWithPublicKeyAddress;

        beforeAll(async () => {
            context = await createPerReplyCommunity();
            authorSigner = await context.publisherPKC.createSigner();
            otherSigner = await context.publisherPKC.createSigner();
        });

        afterAll(async () => {
            await context.cleanup();
        });

        it('Spec: community re-signs every new comment with a fresh anonymized author address when pseudonymityMode="per-reply"', async () => {
            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const reply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, reply);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(reply.cid) as AliasRow;
            expect(aliasRow).to.exist;
            expect(aliasRow.mode).to.equal("per-reply");
            expect(aliasRow.originalAuthorPublicKey).to.equal(authorSigner.publicKey);

            const aliasSigner = await context.publisherPKC.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });
            const stored = (context.community as LocalCommunity)._dbHandler.queryComment(reply.cid) as StoredComment;

            expect(stored?.author?.address).to.be.undefined;
            expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            expect(stored?.signature?.publicKey).to.not.equal(authorSigner.publicKey);
            expect(stored?.pseudonymityMode).to.equal("per-reply");
            await expectCommentCidToUseAlias(context.publisherPKC, reply.cid, aliasSigner);

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
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const firstReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, firstReply);
            const secondReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, secondReply);

            const firstAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                firstReply.cid
            ) as AliasRow;
            const secondAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                secondReply.cid
            ) as AliasRow;

            expect(firstAlias).to.exist;
            expect(secondAlias).to.exist;
            expect(firstAlias.aliasPrivateKey).to.not.equal(secondAlias.aliasPrivateKey);

            const firstAliasSigner = await context.publisherPKC.createSigner({
                privateKey: firstAlias.aliasPrivateKey,
                type: "ed25519"
            });
            const secondAliasSigner = await context.publisherPKC.createSigner({
                privateKey: secondAlias.aliasPrivateKey,
                type: "ed25519"
            });

            expect(firstAliasSigner.address).to.not.equal(secondAliasSigner.address);
            await expectCommentCidToUseAlias(context.publisherPKC, firstReply.cid, firstAliasSigner);
            await expectCommentCidToUseAlias(context.publisherPKC, secondReply.cid, secondAliasSigner);
            await post.stop();
            await firstReply.stop();
            await secondReply.stop();
        });
        it("Spec: anonymized author addresses are never reused for the same signer across replies", async () => {
            const firstPost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, firstPost);
            const firstReply = await publishRandomReply({
                parentComment: firstPost as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, firstReply);

            const secondPost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, secondPost);
            const secondReply = await publishRandomReply({
                parentComment: secondPost as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, secondReply);

            const firstAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                firstReply.cid
            ) as AliasRow;
            const secondAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                secondReply.cid
            ) as AliasRow;

            expect(firstAlias).to.exist;
            expect(secondAlias).to.exist;
            expect(firstAlias.aliasPrivateKey).to.not.equal(secondAlias.aliasPrivateKey);

            const firstAliasSigner = await context.publisherPKC.createSigner({
                privateKey: firstAlias.aliasPrivateKey,
                type: "ed25519"
            });
            const secondAliasSigner = await context.publisherPKC.createSigner({
                privateKey: secondAlias.aliasPrivateKey,
                type: "ed25519"
            });

            expect(firstAliasSigner.address).to.not.equal(secondAliasSigner.address);
            await expectCommentCidToUseAlias(context.publisherPKC, firstReply.cid, firstAliasSigner);
            await expectCommentCidToUseAlias(context.publisherPKC, secondReply.cid, secondAliasSigner);
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
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const noisyReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    author: noisyAuthor,
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, noisyReply);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                noisyReply.cid
            ) as AliasRow;
            const aliasSigner = await context.publisherPKC.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });

            const stored = (context.community as LocalCommunity)._dbHandler.queryComment(noisyReply.cid) as StoredComment;
            expect(stored?.author).to.deep.equal({ displayName: noisyAuthor.displayName });
            expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            await expectCommentCidToUseAlias(context.publisherPKC, noisyReply.cid, aliasSigner);
            await post.stop();
            await noisyReply.stop();
        });

        it("Spec: anonymized publication omits author.previousCommentCid", async () => {
            const chainAuthor = await context.publisherPKC.createSigner();
            const previousPost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: chainAuthor }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, previousPost);

            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: chainAuthor }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const chainedReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: chainAuthor,
                    author: { previousCommentCid: previousPost.cid, address: chainAuthor.address }
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, chainedReply);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                chainedReply.cid
            ) as AliasRow;
            const aliasSigner = await context.publisherPKC.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });
            const stored = (context.community as LocalCommunity)._dbHandler.queryComment(chainedReply.cid) as StoredComment;
            expect(stored?.author?.previousCommentCid).to.be.undefined;
            expect(stored?.author?.address).to.be.undefined;
            await expectCommentCidToUseAlias(context.publisherPKC, chainedReply.cid, aliasSigner);
            await previousPost.stop();
            await post.stop();
            await chainedReply.stop();
        });

        it("Spec: comment edit signed by original author is accepted and re-signed with anonymized author key", async () => {
            const editSigner = await context.publisherPKC.createSigner();
            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: editSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const editableReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: editSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, editableReply);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                editableReply.cid
            ) as AliasRow;
            expect(aliasRow).to.exist;
            const aliasSigner = await context.publisherPKC.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });

            const editedContent = "Edited content - " + Date.now();
            const edit = await context.publisherPKC.createCommentEdit({
                communityAddress: editableReply.communityAddress,
                commentCid: editableReply.cid,
                content: editedContent,
                signer: editSigner
            });
            await publishWithExpectedResult({ publication: edit, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: context.community,
                predicate: async () =>
                    (
                        (context.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({ cid: editableReply.cid }) as
                            | StoredCommentUpdate
                            | undefined
                    )?.edit?.content === editedContent
            });

            const storedUpdate = (context.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                cid: editableReply.cid
            }) as StoredCommentUpdate;
            expect(storedUpdate?.edit?.content).to.equal(editedContent);
            expect(storedUpdate?.edit?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            const storedComment = (context.community as LocalCommunity)._dbHandler.queryComment(editableReply.cid) as StoredComment;
            expect(storedComment?.author?.address).to.be.undefined;
            await expectCommentCidToUseAlias(context.publisherPKC, editableReply.cid, aliasSigner);
            await post.stop();
            await editableReply.stop();
        });

        it("Spec: comment edit is rejected when original author does not match stored anonymization mapping", async () => {
            const ownerSigner = await context.publisherPKC.createSigner();
            const intruderSigner = await context.publisherPKC.createSigner();
            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: ownerSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const targetReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: ownerSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, targetReply);

            const badEdit = await context.publisherPKC.createCommentEdit({
                communityAddress: targetReply.communityAddress,
                commentCid: targetReply.cid,
                content: "Unauthorized edit " + Date.now(),
                signer: intruderSigner
            });
            await publishWithExpectedResult({
                publication: badEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_EDIT_CAN_NOT_EDIT_COMMENT_IF_NOT_ORIGINAL_AUTHOR
            });

            const storedUpdate = (context.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({ cid: targetReply.cid }) as
                | StoredCommentUpdate
                | undefined;
            expect(storedUpdate?.edit).to.be.undefined;
            await post.stop();
            await targetReply.stop();
        });

        it("Spec: anonymized comment.signature.publicKey differs from original author's signer publicKey", async () => {
            const freshSigner = await context.publisherPKC.createSigner();
            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: freshSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const reply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: { signer: freshSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, reply);

            const stored = (context.community as LocalCommunity)._dbHandler.queryComment(reply.cid) as StoredComment;
            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(reply.cid) as AliasRow;
            expect(aliasRow).to.exist;
            const aliasSigner = await context.publisherPKC.createSigner({
                privateKey: aliasRow.aliasPrivateKey,
                type: "ed25519"
            });
            expect(stored?.signature?.publicKey).to.not.equal(freshSigner.publicKey);
            expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            expect(stored?.author?.address).to.be.undefined;
            await expectCommentCidToUseAlias(context.publisherPKC, reply.cid, aliasSigner);
            await post.stop();
            await reply.stop();
        });

        it("Spec: purging an anonymized comment removes its alias mapping", async () => {
            const purgeSigner = await context.publisherPKC.createSigner();
            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: purgeSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const purgeTarget = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: purgeSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, purgeTarget);

            const aliasBeforePurge = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                purgeTarget.cid
            ) as AliasRow | undefined;
            expect(aliasBeforePurge).to.exist;

            await (context.community as LocalCommunity)._dbHandler.purgeComment(purgeTarget.cid);

            const aliasAfterPurge = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(purgeTarget.cid) as
                | AliasRow
                | undefined;
            expect(aliasAfterPurge).to.be.undefined;
            const commentAfterPurge = (context.community as LocalCommunity)._dbHandler.queryComment(purgeTarget.cid) as
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
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const authoredReply = await context.publisherPKC.createComment({
                communityAddress: context.community.address,
                signer: authorSigner,
                author: originalAuthor,
                content: originalContent,
                parentCid: post.cid,
                postCid: post.cid
            });
            await publishWithExpectedResult({ publication: authoredReply, expectedChallengeSuccess: true });
            expect(authoredReply.raw.pubsubMessageToPublish).to.be.ok;
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, authoredReply);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                authoredReply.cid
            ) as AliasRow;
            expect(aliasRow).to.exist;
            const alias = await context.publisherPKC.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });
            const rawPubsub = () => authoredReply.raw.pubsubMessageToPublish;
            const expectOriginalFields = () => {
                expect(rawPubsub()?.author?.displayName).to.equal(originalAuthor.displayName);
                expect(rawPubsub()?.author?.wallets).to.deep.equal(originalAuthor.wallets);
                expect(rawPubsub()?.author?.flairs).to.deep.equal(originalAuthor.flairs);
                expect(rawPubsub()?.author?.previousCommentCid).to.equal(originalAuthor.previousCommentCid);
                expect(rawPubsub()?.content).to.equal(originalContent);
                expect(rawPubsub()?.signature?.publicKey).to.equal(authorSigner.publicKey);
            };

            const stored = (context.community as LocalCommunity)._dbHandler.queryComment(authoredReply.cid) as StoredComment;
            expect(stored?.author?.address).to.be.undefined;
            expect(stored?.signature?.publicKey).to.equal(alias.publicKey);
            await expectCommentCidToUseAlias(context.publisherPKC, authoredReply.cid, alias);
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
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const firstReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, firstReply);

            const secondReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, secondReply);

            // Get alias for first reply
            const firstAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                firstReply.cid
            ) as AliasRow;
            expect(firstAlias).to.exist;

            // Make multiple edits to the same reply
            const firstEditContent = "First edit - " + Date.now();
            const firstEdit = await context.publisherPKC.createCommentEdit({
                communityAddress: firstReply.communityAddress,
                commentCid: firstReply.cid,
                content: firstEditContent,
                signer: authorSigner
            });
            await publishWithExpectedResult({ publication: firstEdit, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: context.community,
                predicate: async () =>
                    (
                        (context.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({ cid: firstReply.cid }) as
                            | StoredCommentUpdate
                            | undefined
                    )?.edit?.content === firstEditContent
            });

            const secondEditContent = "Second edit - " + Date.now();
            const secondEdit = await context.publisherPKC.createCommentEdit({
                communityAddress: firstReply.communityAddress,
                commentCid: firstReply.cid,
                content: secondEditContent,
                signer: authorSigner
            });
            await publishWithExpectedResult({ publication: secondEdit, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: context.community,
                predicate: async () =>
                    (
                        (context.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({ cid: firstReply.cid }) as
                            | StoredCommentUpdate
                            | undefined
                    )?.edit?.content === secondEditContent
            });

            // Verify alias stayed the same across edits
            const aliasAfterEdits = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                firstReply.cid
            ) as AliasRow;
            expect(aliasAfterEdits).to.exist;
            expect(aliasAfterEdits.aliasPrivateKey).to.equal(firstAlias.aliasPrivateKey);

            // Verify different replies have different aliases
            const secondAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                secondReply.cid
            ) as AliasRow;
            expect(secondAlias).to.exist;
            expect(secondAlias.aliasPrivateKey).to.not.equal(firstAlias.aliasPrivateKey);
            const aliasSigner = await context.publisherPKC.createSigner({
                privateKey: aliasAfterEdits.aliasPrivateKey,
                type: "ed25519"
            });
            const secondAliasSigner = await context.publisherPKC.createSigner({
                privateKey: secondAlias.aliasPrivateKey,
                type: "ed25519"
            });
            await expectCommentCidToUseAlias(context.publisherPKC, firstReply.cid, aliasSigner);
            await expectCommentCidToUseAlias(context.publisherPKC, secondReply.cid, secondAliasSigner);

            await post.stop();
            await firstReply.stop();
            await secondReply.stop();
        });

        it("Spec: same signer posting replies across different posts gets a fresh anonymized address for each reply (no cross-post reuse)", async () => {
            const firstPost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, firstPost);

            const firstReply = await publishRandomReply({
                parentComment: firstPost as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, firstReply);

            const secondPost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, secondPost);

            const secondReply = await publishRandomReply({
                parentComment: secondPost as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, secondReply);

            const firstAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                firstReply.cid
            ) as AliasRow;
            const secondAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                secondReply.cid
            ) as AliasRow;

            expect(firstAlias).to.exist;
            expect(secondAlias).to.exist;
            expect(firstAlias.aliasPrivateKey).to.not.equal(secondAlias.aliasPrivateKey);

            const firstAliasSigner = await context.publisherPKC.createSigner({
                privateKey: firstAlias.aliasPrivateKey,
                type: "ed25519"
            });
            const secondAliasSigner = await context.publisherPKC.createSigner({
                privateKey: secondAlias.aliasPrivateKey,
                type: "ed25519"
            });

            expect(firstAliasSigner.address).to.not.equal(secondAliasSigner.address);
            await expectCommentCidToUseAlias(context.publisherPKC, firstReply.cid, firstAliasSigner);
            await expectCommentCidToUseAlias(context.publisherPKC, secondReply.cid, secondAliasSigner);
            await firstPost.stop();
            await secondPost.stop();
            await firstReply.stop();
            await secondReply.stop();
        });

        it("Spec: author.address domains resolve and are anonymized per reply", async () => {
            const domainSigner = await context.publisherPKC.createSigner(signers[3]);
            const domainAddress = "plebbit.bso";
            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: domainSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const { resolvedAuthorName: resolvedAddress } = await context.publisherPKC.resolveAuthorName({ name: domainAddress });
            expect(resolvedAddress).to.equal(domainSigner.address);

            const domainReply = await context.publisherPKC.createComment({
                communityAddress: context.community.address,
                signer: domainSigner,
                author: { address: domainAddress, name: domainAddress, displayName: "Domain author" },
                content: "Domain anonymization content " + Date.now(),
                parentCid: post.cid,
                postCid: post.cid
            });
            await publishWithExpectedResult({ publication: domainReply, expectedChallengeSuccess: true });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, domainReply);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                domainReply.cid
            ) as AliasRow;
            expect(aliasRow).to.exist;
            const aliasSigner = await context.publisherPKC.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });

            const stored = (context.community as LocalCommunity)._dbHandler.queryComment(domainReply.cid) as StoredComment;
            expect(stored?.author?.address).to.be.undefined;
            expect(stored?.author?.name).to.be.undefined;
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

            await expectCommentCidToUseAlias(context.publisherPKC, domainReply.cid, aliasSigner);

            await post.stop();
            await domainReply.stop();
        });

        it("Spec: reply-to-reply (nested) anonymization creates a unique alias distinct from parent/post aliases and strips author metadata except displayName", async () => {
            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const reply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, reply);

            const nestedReply = await publishRandomReply({
                parentComment: reply as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, nestedReply);

            const replyAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(reply.cid) as AliasRow;
            const nestedAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                nestedReply.cid
            ) as AliasRow;

            expect(replyAlias).to.exist;
            expect(nestedAlias).to.exist;
            expect(replyAlias.aliasPrivateKey).to.not.equal(nestedAlias.aliasPrivateKey);

            const replyAliasSigner = await context.publisherPKC.createSigner({
                privateKey: replyAlias.aliasPrivateKey,
                type: "ed25519"
            });
            const nestedAliasSigner = await context.publisherPKC.createSigner({
                privateKey: nestedAlias.aliasPrivateKey,
                type: "ed25519"
            });

            expect(replyAliasSigner.address).to.not.equal(nestedAliasSigner.address);

            const storedNested = (context.community as LocalCommunity)._dbHandler.queryComment(nestedReply.cid) as StoredComment;
            expect(storedNested?.author?.address).to.be.undefined;
            expect(storedNested?.author?.displayName).to.equal(nestedReply.author.displayName);
            expect(storedNested?.author?.wallets).to.be.undefined;
            await expectCommentCidToUseAlias(context.publisherPKC, nestedReply.cid, nestedAliasSigner);

            await post.stop();
            await reply.stop();
            await nestedReply.stop();
        });

        it("Spec: disabling pseudonymousAuthors stops anonymization for new replies without rewriting previously stored anonymized replies", async () => {
            const localContext = await createPerReplyCommunity();
            const localAuthor = await localContext.publisherPKC.createSigner();

            let post: Comment | undefined;
            let anonymizedReply: Comment | undefined;
            let plainReply: Comment | undefined;
            try {
                // Create anonymized reply before disabling
                post = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, post);

                anonymizedReply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    pkc: localContext.publisherPKC,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, anonymizedReply);

                const anonymizedAlias = (localContext.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                    anonymizedReply.cid
                ) as AliasRow | undefined;
                expect(anonymizedAlias).to.exist;

                // Disable anonymization
                await localContext.community.edit({ features: { pseudonymityMode: undefined } });
                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () => localContext.community.features.pseudonymityMode === undefined
                });

                // Create new reply after disabling - should not be anonymized
                plainReply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    pkc: localContext.publisherPKC,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, plainReply);

                const storedPlain = (localContext.community as LocalCommunity)._dbHandler.queryComment(plainReply.cid) as StoredComment;
                expect(storedPlain?.author?.address).to.be.undefined;
                expect(storedPlain?.signature?.publicKey).to.equal(localAuthor.publicKey);

                const plainAlias = (localContext.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                    plainReply.cid
                ) as AliasRow | undefined;
                expect(plainAlias).to.be.undefined;

                // Verify old anonymized reply is still anonymized
                const storedAnonymized = (localContext.community as LocalCommunity)._dbHandler.queryComment(
                    anonymizedReply.cid
                ) as StoredComment;
                expect(storedAnonymized?.author?.address).to.be.undefined;
                expect(storedAnonymized?.signature?.publicKey).to.not.equal(localAuthor.publicKey);
                const anonymizedAliasSigner = await localContext.publisherPKC.createSigner({
                    privateKey: anonymizedAlias!.aliasPrivateKey,
                    type: "ed25519"
                });
                await expectCommentCidToUseAlias(localContext.publisherPKC, anonymizedReply.cid, anonymizedAliasSigner);
            } finally {
                await post?.stop();
                await anonymizedReply?.stop();
                await plainReply?.stop();
                await localContext.cleanup();
            }
        });

        it("Spec: purging one anonymized reply removes only that reply's alias mapping and leaves other replies (even from the same signer) intact", async () => {
            expect(context.community.features.pseudonymityMode).to.equal("per-reply");

            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const firstReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, firstReply);

            const secondReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, secondReply);

            expect(context.community.features.pseudonymityMode).to.equal("per-reply");

            // Verify both aliases exist
            const firstAliasBefore = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                firstReply.cid
            ) as AliasRow;
            const secondAliasBefore = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                secondReply.cid
            ) as AliasRow;
            expect(firstAliasBefore).to.exist;
            expect(secondAliasBefore).to.exist;

            // Purge only the first reply
            await (context.community as LocalCommunity)._dbHandler.purgeComment(firstReply.cid);

            // Verify first reply and alias are gone
            const firstAliasAfter = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(firstReply.cid) as
                | AliasRow
                | undefined;
            const firstCommentAfter = (context.community as LocalCommunity)._dbHandler.queryComment(firstReply.cid) as
                | StoredComment
                | undefined;
            expect(firstAliasAfter).to.be.undefined;
            expect(firstCommentAfter).to.be.undefined;

            // Verify second reply and alias are still there
            const secondAliasAfter = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                secondReply.cid
            ) as AliasRow;
            const secondCommentAfter = (context.community as LocalCommunity)._dbHandler.queryComment(secondReply.cid) as StoredComment;
            expect(secondAliasAfter).to.exist;
            expect(secondCommentAfter).to.exist;
            expect(secondAliasAfter.aliasPrivateKey).to.equal(secondAliasBefore.aliasPrivateKey);

            await post.stop();
            await firstReply.stop();
            await secondReply.stop();
        });

        it("Spec: community owner can resolve multiple anonymized addresses created by the same signer across several replies and map each back to the original signer", async () => {
            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const firstReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, firstReply);

            const secondReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, secondReply);

            const thirdReply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, thirdReply);

            // Verify all aliases exist and map to the same original signer
            const firstAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                firstReply.cid
            ) as AliasRow;
            const secondAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                secondReply.cid
            ) as AliasRow;
            const thirdAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                thirdReply.cid
            ) as AliasRow;

            expect(firstAlias).to.exist;
            expect(secondAlias).to.exist;
            expect(thirdAlias).to.exist;

            expect(firstAlias.originalAuthorPublicKey).to.equal(authorSigner.publicKey);
            expect(secondAlias.originalAuthorPublicKey).to.equal(authorSigner.publicKey);
            expect(thirdAlias.originalAuthorPublicKey).to.equal(authorSigner.publicKey);

            // Verify all aliases are unique
            expect(firstAlias.aliasPrivateKey).to.not.equal(secondAlias.aliasPrivateKey);
            expect(firstAlias.aliasPrivateKey).to.not.equal(thirdAlias.aliasPrivateKey);
            expect(secondAlias.aliasPrivateKey).to.not.equal(thirdAlias.aliasPrivateKey);

            await post.stop();
            await firstReply.stop();
            await secondReply.stop();
            await thirdReply.stop();
        });

        it("Spec: community owner can resolve anonymized author addresses back to the original author address", async () => {
            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const reply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, reply);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(reply.cid) as AliasRow;
            expect(aliasRow).to.exist;
            expect(aliasRow.mode).to.equal("per-reply");
            expect(aliasRow.originalAuthorPublicKey).to.equal(authorSigner.publicKey);

            const aliasSigner = await context.publisherPKC.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });
            expect(aliasSigner.address).to.be.a("string");
            expect(aliasSigner.address).to.not.equal(authorSigner.address);

            await post.stop();
            await reply.stop();
        });

        it("Spec: challengerequest emits full publication author.community fields without anonymization in per-reply mode", async () => {
            const localContext = await createPerReplyCommunity();
            const localAuthor = await localContext.publisherPKC.createSigner();
            const voter = await localContext.publisherPKC.createSigner();

            try {
                const seededPost = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, seededPost);

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () => !!(localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(localAuthor.address)
                });

                const communityAuthorBefore = (localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(
                    localAuthor.address
                ) as CommunityAuthorRow;
                expect(communityAuthorBefore, "expected community author to exist for original signer").to.be.ok;
                expect(communityAuthorBefore.lastCommentCid).to.equal(seededPost.cid);
                expect(communityAuthorBefore.firstCommentTimestamp).to.equal(seededPost.timestamp);
                expect(communityAuthorBefore.postScore).to.equal(0);
                expect(communityAuthorBefore.replyScore).to.equal(0);

                const challengeRequestPromise = new Promise<DecryptedChallengeRequestMessageTypeWithCommunityAuthor>((resolve) =>
                    localContext.community.once("challengerequest", resolve)
                );
                const publication = await localContext.publisherPKC.createComment({
                    communityAddress: localContext.community.address,
                    signer: localAuthor,
                    content: "per-reply challengerequest author.community check",
                    title: "per-reply challengerequest author.community check"
                });
                await publishWithExpectedResult({ publication: publication, expectedChallengeSuccess: true });

                const challengerequest = await challengeRequestPromise;
                expect(challengerequest.comment.author.address).to.equal(localAuthor.address);
                expect(challengerequest.comment.author.community).to.deep.equal(communityAuthorBefore);
                expect(challengerequest.comment.author.community?.lastCommentCid).to.equal(seededPost.cid);
                expect(challengerequest.comment.author.community?.firstCommentTimestamp).to.equal(seededPost.timestamp);
                expect(challengerequest.comment.author.community?.postScore).to.equal(0);
                expect(challengerequest.comment.author.community?.replyScore).to.equal(0);

                await seededPost.stop();
                await publication.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.community.lastCommentCid equals the publication cid when pseudonymityMode is per-reply", async () => {
            const localContext = await createPerReplyCommunity();
            const localAuthor = await localContext.publisherPKC.createSigner();

            try {
                const post = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, post);

                const reply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    pkc: localContext.publisherPKC,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, reply);

                const postUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                const replyUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: reply.cid
                }) as StoredCommentUpdate;
                expect(postUpdate?.author?.community?.lastCommentCid).to.equal(post.cid);
                expect(replyUpdate?.author?.community?.lastCommentCid).to.equal(reply.cid);

                await post.stop();
                await reply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.community.banExpiresAt rejects publications and only surfaces on the specific banned comment when pseudonymityMode is per-reply", async () => {
            const localContext = await createPerReplyCommunity();
            const localAuthor = await localContext.publisherPKC.createSigner();
            const moderator = await localContext.publisherPKC.createSigner();

            await localContext.community.edit({ roles: { [moderator.address]: { role: "moderator" } } });
            await resolveWhenConditionIsTrue({
                toUpdate: localContext.community,
                predicate: async () => typeof localContext.community.updatedAt === "number"
            });

            try {
                const post = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, post);

                const firstReply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    pkc: localContext.publisherPKC,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, firstReply);

                const secondReply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    pkc: localContext.publisherPKC,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, secondReply);

                const banExpiresAt = timestamp() + 60;
                const banModeration = await localContext.publisherPKC.createCommentModeration({
                    communityAddress: localContext.community.address,
                    commentCid: firstReply.cid,
                    commentModeration: { author: { banExpiresAt }, reason: "ban for per-reply test" },
                    signer: moderator
                });
                await publishWithExpectedResult({ publication: banModeration, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () =>
                        (
                            (localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(localAuthor.address) as
                                | CommunityAuthorRow
                                | undefined
                        )?.banExpiresAt === banExpiresAt
                });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () => {
                        const firstUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                            cid: firstReply.cid
                        }) as StoredCommentUpdate | undefined;
                        return firstUpdate?.author?.community?.banExpiresAt === banExpiresAt;
                    }
                });

                const secondUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: secondReply.cid
                }) as StoredCommentUpdate | undefined;
                expect(secondUpdate?.author?.community?.banExpiresAt).to.be.undefined;

                const blockedReply = await localContext.publisherPKC.createComment({
                    communityAddress: localContext.community.address,
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
            const localContext = await createPerReplyCommunity();
            const localAuthor = await localContext.publisherPKC.createSigner();
            const moderator = await localContext.publisherPKC.createSigner();

            await localContext.community.edit({ roles: { [moderator.address]: { role: "moderator" } } });
            await resolveWhenConditionIsTrue({
                toUpdate: localContext.community,
                predicate: async () => typeof localContext.community.updatedAt === "number"
            });

            try {
                const post = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, post);

                const reply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    pkc: localContext.publisherPKC,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, reply);

                const aliasRow = (localContext.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                    reply.cid
                ) as AliasRow;
                expect(aliasRow).to.exist;
                const aliasSigner = await localContext.publisherPKC.createSigner({
                    privateKey: aliasRow.aliasPrivateKey,
                    type: "ed25519"
                });
                expect(aliasSigner.address).to.not.equal(localAuthor.address);

                const banExpiresAt = timestamp() + 60;
                const banModeration = await localContext.publisherPKC.createCommentModeration({
                    communityAddress: localContext.community.address,
                    commentCid: reply.cid,
                    commentModeration: { author: { banExpiresAt }, reason: "ban alias mapping test" },
                    signer: moderator
                });
                await publishWithExpectedResult({ publication: banModeration, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () => {
                        const originalAuthor = (localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(
                            localAuthor.address
                        ) as CommunityAuthorRow | undefined;
                        const aliasAuthor = (localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(
                            aliasSigner.address
                        ) as CommunityAuthorRow | undefined;
                        return originalAuthor?.banExpiresAt === banExpiresAt && aliasAuthor?.banExpiresAt === banExpiresAt;
                    }
                });

                const originalAuthor = (localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(
                    localAuthor.address
                ) as CommunityAuthorRow;
                const aliasAuthor = (localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(
                    aliasSigner.address
                ) as CommunityAuthorRow;
                expect(originalAuthor?.banExpiresAt).to.equal(banExpiresAt);
                expect(aliasAuthor?.banExpiresAt).to.equal(banExpiresAt);

                await post.stop();
                await reply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.community.postScore stays 0 when pseudonymityMode is per-reply even if author has post karma", async () => {
            const localContext = await createPerReplyCommunity();
            const localAuthor = await localContext.publisherPKC.createSigner();
            const voter = await localContext.publisherPKC.createSigner();

            try {
                const post = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, post);

                const upvote = await localContext.publisherPKC.createVote({
                    communityAddress: localContext.community.address,
                    commentCid: post.cid,
                    vote: 1,
                    signer: voter
                });
                await publishWithExpectedResult({ publication: upvote, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () =>
                        Boolean((localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({ cid: post.cid }))
                });

                const postUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                expect(postUpdate?.author?.community?.postScore).to.equal(0);

                await post.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.community.replyScore reflects that single reply's karma when pseudonymityMode is per-reply", async () => {
            const localContext = await createPerReplyCommunity();
            const localAuthor = await localContext.publisherPKC.createSigner();
            const voter = await localContext.publisherPKC.createSigner();

            try {
                const post = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, post);
                const reply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    pkc: localContext.publisherPKC,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, reply);

                // TODO publish upvote to post, and make sure its replyScore = 0
                const upvote = await localContext.publisherPKC.createVote({
                    communityAddress: localContext.community.address,
                    commentCid: reply.cid,
                    vote: 1,
                    signer: voter
                });
                await publishWithExpectedResult({ publication: upvote, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () =>
                        (
                            (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({ cid: reply.cid }) as
                                | StoredCommentUpdate
                                | undefined
                        )?.author?.community?.replyScore === 1
                });

                const postUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                const replyUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: reply.cid
                }) as StoredCommentUpdate;
                expect(postUpdate?.author?.community?.replyScore).to.equal(0);
                expect(replyUpdate?.author?.community?.replyScore).to.equal(1);

                await post.stop();
                await reply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.community.replyScore is tracked per reply when pseudonymityMode is per-reply", async () => {
            const localContext = await createPerReplyCommunity();
            const localAuthor = await localContext.publisherPKC.createSigner();
            const voter = await localContext.publisherPKC.createSigner();

            try {
                const post = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, post);

                const firstReply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    pkc: localContext.publisherPKC,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, firstReply);

                const secondReply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    pkc: localContext.publisherPKC,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, secondReply);

                const upvoteSecondReply = await localContext.publisherPKC.createVote({
                    communityAddress: localContext.community.address,
                    commentCid: secondReply.cid,
                    vote: 1,
                    signer: voter
                });
                await publishWithExpectedResult({ publication: upvoteSecondReply, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () => {
                        const firstUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                            cid: firstReply.cid
                        }) as StoredCommentUpdate | undefined;
                        const secondUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                            cid: secondReply.cid
                        }) as StoredCommentUpdate | undefined;
                        return (
                            !!firstUpdate &&
                            secondUpdate?.author?.community?.replyScore === 1 &&
                            typeof firstUpdate?.author?.community?.replyScore === "number"
                        );
                    }
                });

                const postUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                const firstReplyUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: firstReply.cid
                }) as StoredCommentUpdate;
                const secondReplyUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: secondReply.cid
                }) as StoredCommentUpdate;

                expect(postUpdate?.author?.community?.replyScore).to.equal(0);
                expect(firstReplyUpdate?.author?.community?.replyScore).to.equal(0);
                expect(secondReplyUpdate?.author?.community?.replyScore).to.equal(1);

                await post.stop();
                await firstReply.stop();
                await secondReply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.community.firstCommentTimestamp is the reply timestamp when pseudonymityMode is per-reply", async () => {
            const localContext = await createPerReplyCommunity();
            const localAuthor = await localContext.publisherPKC.createSigner();

            try {
                const post = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, post);

                const postUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                expect(postUpdate?.author?.community?.firstCommentTimestamp).to.equal(post.timestamp);

                const reply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    pkc: localContext.publisherPKC,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, reply);
                const replyUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: reply.cid
                }) as StoredCommentUpdate;
                expect(replyUpdate?.author?.community?.firstCommentTimestamp).to.equal(reply.timestamp);

                await post.stop();
                await reply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.community in CommentUpdate does NOT include karma from original author's prior comments when pseudonymityMode is per-reply", async () => {
            // This test verifies that enabling pseudonymity mode doesn't leak prior karma into new aliases
            // 1. Author builds karma without pseudonymity mode
            // 2. Enable pseudonymity mode
            // 3. Author publishes new comment (gets an alias)
            // 4. Alias's author.community should show 0 karma, not the original author's prior karma

            const pkc = await mockPKC();
            const community = await createSubWithNoChallenge({}, pkc);

            // Ensure pseudonymity mode is initially disabled
            await community.edit({ features: { pseudonymityMode: undefined } });
            await community.start();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => typeof community.updatedAt === "number"
            });

            const author = await pkc.createSigner();
            const voter = await pkc.createSigner();

            try {
                // Step 1: Build up karma without pseudonymity mode
                const nonPseudonymousPost = await publishRandomPost({
                    communityAddress: community.address,
                    pkc: pkc,
                    postProps: { signer: author }
                });
                await waitForStoredCommentUpdateWithAssertions(community as LocalCommunity, nonPseudonymousPost);

                // Upvote the post to give author post karma
                const upvote = await pkc.createVote({
                    communityAddress: community.address,
                    commentCid: nonPseudonymousPost.cid,
                    vote: 1,
                    signer: voter
                });
                await publishWithExpectedResult({ publication: upvote, expectedChallengeSuccess: true });

                // Verify original author has post karma
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => {
                        const authorCommunity = (community as LocalCommunity)._dbHandler.queryCommunityAuthor(author.address);
                        return authorCommunity?.postScore === 1;
                    }
                });

                const originalAuthorKarma = (community as LocalCommunity)._dbHandler.queryCommunityAuthor(author.address);
                expect(originalAuthorKarma?.postScore).to.equal(1);

                // Step 2: Enable pseudonymity mode
                await community.edit({ features: { pseudonymityMode: "per-reply" } });
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => community.features?.pseudonymityMode === "per-reply"
                });

                // Step 3: Author publishes a new comment (gets an alias)
                const pseudonymousReply = await publishRandomReply({
                    parentComment: nonPseudonymousPost as CommentIpfsWithCidDefined,
                    pkc: pkc,
                    commentProps: {
                        signer: author
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(community as LocalCommunity, pseudonymousReply);

                // Step 4: Verify the alias's CommentUpdate shows isolated karma (0), not original author's karma (1)
                const replyUpdate = (community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: pseudonymousReply.cid
                }) as StoredCommentUpdate;

                // The alias should have its own isolated karma, not the original author's karma
                expect(replyUpdate?.author?.community?.postScore).to.equal(0);
                expect(replyUpdate?.author?.community?.replyScore).to.equal(0);

                // Verify the alias is different from the original author
                const aliasRow = (community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(pseudonymousReply.cid);
                expect(aliasRow).to.exist;
                expect(aliasRow?.originalAuthorPublicKey).to.equal(author.publicKey);

                // Double-check: original author's karma should still be 1
                const originalAuthorKarmaAfter = (community as LocalCommunity)._dbHandler.queryCommunityAuthor(author.address);
                expect(originalAuthorKarmaAfter?.postScore).to.equal(1);

                await nonPseudonymousPost.stop();
                await pseudonymousReply.stop();
            } finally {
                await community.stop();
                await pkc.destroy();
            }
        });

        it("Spec: banning a reply in per-reply mode surfaces banExpiresAt on that reply and blocks further replies and posts", async () => {
            const localContext = await createPerReplyCommunity();
            const localAuthor = await localContext.publisherPKC.createSigner();
            const moderator = await localContext.publisherPKC.createSigner();

            await localContext.community.edit({ roles: { [moderator.address]: { role: "moderator" } } });
            await resolveWhenConditionIsTrue({
                toUpdate: localContext.community,
                predicate: async () => typeof localContext.community.updatedAt === "number"
            });

            try {
                const post = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, post);
                const firstReply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    pkc: localContext.publisherPKC,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, firstReply);

                const secondReply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    pkc: localContext.publisherPKC,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, secondReply);

                const banExpiresAt = timestamp() + 60;
                const banModeration = await localContext.publisherPKC.createCommentModeration({
                    communityAddress: localContext.community.address,
                    commentCid: firstReply.cid,
                    commentModeration: { author: { banExpiresAt }, reason: "ban for per-reply test" },
                    signer: moderator
                });
                await publishWithExpectedResult({ publication: banModeration, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () => {
                        const update = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                            cid: firstReply.cid
                        }) as StoredCommentUpdate | undefined;
                        return update?.author?.community?.banExpiresAt === banExpiresAt;
                    }
                });

                const secondUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: secondReply.cid
                }) as StoredCommentUpdate | undefined;
                expect(secondUpdate?.author?.community?.banExpiresAt).to.be.undefined;

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () =>
                        (
                            (localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(localAuthor.address) as
                                | CommunityAuthorRow
                                | undefined
                        )?.banExpiresAt === banExpiresAt
                });

                const blockedReply = await localContext.publisherPKC.createComment({
                    communityAddress: localContext.community.address,
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

                const blockedPost = await localContext.publisherPKC.createComment({
                    communityAddress: localContext.community.address,
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
            context = await createPerReplyCommunity();
            duplicateSigner = await context.publisherPKC.createSigner();
        });

        afterAll(async () => {
            await context.cleanup();
        });

        it("Spec: rejects duplicate post publication in per-reply pseudonymity mode", async () => {
            let originalPost: Comment | undefined;
            let duplicatePost: Comment | undefined;

            try {
                originalPost = await context.publisherPKC.createComment({
                    communityAddress: context.community.address,
                    signer: duplicateSigner,
                    title: `duplicate-per-reply-title-${Date.now()}`,
                    content: `duplicate-per-reply-content-${Date.now()}`
                });
                await publishWithExpectedResult({ publication: originalPost, expectedChallengeSuccess: true });
                const originalPublication = clonePublication(originalPost.raw.pubsubMessageToPublish!);
                await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, originalPost);

                // First 1 duplicate attempt should succeed idempotently
                for (let i = 0; i < 1; i++) {
                    const idempotentDup = await context.publisherPKC.createComment(originalPublication);
                    try {
                        await publishWithExpectedResult({ publication: idempotentDup, expectedChallengeSuccess: true });
                    } finally {
                        await idempotentDup.stop();
                    }
                }
                // 2nd attempt should fail
                duplicatePost = await context.publisherPKC.createComment(originalPublication);
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
                    communityAddress: context.community.address,
                    pkc: context.publisherPKC,
                    postProps: { signer: duplicateSigner }
                });
                await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, parentPost);

                originalReply = await context.publisherPKC.createComment({
                    communityAddress: context.community.address,
                    signer: duplicateSigner,
                    parentCid: parentPost.cid,
                    postCid: parentPost.cid,
                    content: `duplicate-per-reply-reply-${Date.now()}`
                });
                await publishWithExpectedResult({ publication: originalReply, expectedChallengeSuccess: true });
                const originalReplyPublication = clonePublication(originalReply.raw.pubsubMessageToPublish!);
                await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, originalReply);

                // First 1 duplicate attempt should succeed idempotently
                for (let i = 0; i < 1; i++) {
                    const idempotentDup = await context.publisherPKC.createComment(originalReplyPublication);
                    try {
                        await publishWithExpectedResult({ publication: idempotentDup, expectedChallengeSuccess: true });
                    } finally {
                        await idempotentDup.stop();
                    }
                }
                // 2nd attempt should fail
                duplicateReply = await context.publisherPKC.createComment(originalReplyPublication);
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
                sharedContext = await createPerReplyCommunity();
                signingAuthor = await sharedContext.publisherPKC.createSigner();

                // Create post and replies
                sharedContext.post = await publishRandomPost({
                    communityAddress: sharedContext.community.address,
                    pkc: sharedContext.publisherPKC,
                    postProps: {
                        signer: signingAuthor
                    }
                });
                sharedContext.postDisplayName = sharedContext.post.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(sharedContext.community as LocalCommunity, sharedContext.post);

                sharedContext.firstReply = await publishRandomReply({
                    parentComment: sharedContext.post as CommentIpfsWithCidDefined,
                    pkc: sharedContext.publisherPKC,
                    commentProps: {
                        signer: signingAuthor
                    }
                });
                sharedContext.firstReplyDisplayName = sharedContext.firstReply.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(sharedContext.community as LocalCommunity, sharedContext.firstReply);

                sharedContext.secondReply = await publishRandomReply({
                    parentComment: sharedContext.post as CommentIpfsWithCidDefined,
                    pkc: sharedContext.publisherPKC,
                    commentProps: {
                        signer: signingAuthor
                    }
                });
                sharedContext.secondReplyDisplayName = sharedContext.secondReply.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(sharedContext.community as LocalCommunity, sharedContext.secondReply);

                await waitTillPostInCommunityPages(sharedContext.post as Comment & { cid: string }, sharedContext.publisherPKC);
                await waitTillReplyInParentPages(
                    sharedContext.firstReply as Comment & { cid: string; parentCid: string },
                    sharedContext.publisherPKC
                );
                await waitTillReplyInParentPages(
                    sharedContext.secondReply as Comment & { cid: string; parentCid: string },
                    sharedContext.publisherPKC
                );

                // Get alias signer for verification
                const firstReplyAlias = (sharedContext.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                    sharedContext.firstReply.cid
                ) as AliasRow;
                expect(firstReplyAlias).to.exist;
                replyAliasSigner = await sharedContext.publisherPKC.createSigner({
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

            remotePKCConfigs.forEach((config) => {
                describe(`${config.name} - preloaded`, () => {
                    let remotePKC: PKC;

                    beforeAll(async () => {
                        remotePKC = await config.pkcInstancePromise();
                        await waitTillPostInCommunityPages(sharedContext.post as Comment & { cid: string }, remotePKC);
                        await waitTillReplyInParentPages(
                            sharedContext.firstReply as Comment & { cid: string; parentCid: string },
                            remotePKC
                        );
                        await waitTillReplyInParentPages(
                            sharedContext.secondReply as Comment & { cid: string; parentCid: string },
                            remotePKC
                        );
                    });

                    afterAll(async () => {
                        await remotePKC?.destroy();
                    });

                    it("Spec: loads preloaded pages with anonymized posts/replies without failing verification", async () => {
                        const remoteCommunity = await remotePKC.getCommunity({ address: sharedContext.community.address });
                        expect(Object.keys(remoteCommunity.posts.pages).length).to.be.greaterThan(0);

                        // Check posts in pages (posts are not anonymized, only replies are)
                        for (const sortName of Object.keys(remoteCommunity.posts.pages)) {
                            const page = remoteCommunity.posts.pages[sortName];
                            const postInPage = page?.comments?.find((c) => c.cid === sharedContext.post?.cid);
                            if (postInPage) {
                                expect(postInPage?.author?.address).to.equal(sharedContext.post?.author.address);
                                expect(postInPage?.signature?.publicKey).to.equal(sharedContext.post?.signature.publicKey);
                                expect(postInPage?.pseudonymityMode).to.equal("per-reply");
                            }
                        }

                        // Check replies in pages - they should be anonymized
                        const remoteParent = await remotePKC.getComment({ cid: sharedContext.post!.cid });
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
                        const remoteReply = await remotePKC.getComment({ cid: sharedContext.firstReply!.cid });
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
                paginatedContext = await createPerReplyCommunity();
                paginatedSigningAuthor = await paginatedContext.publisherPKC.createSigner();

                // Create post and multiple replies for pagination testing
                paginatedContext.post = await publishRandomPost({
                    communityAddress: paginatedContext.community.address,
                    pkc: paginatedContext.publisherPKC,
                    postProps: {
                        signer: paginatedSigningAuthor
                    }
                });
                paginatedContext.postDisplayName = paginatedContext.post.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(paginatedContext.community as LocalCommunity, paginatedContext.post);

                paginatedContext.firstReply = await publishRandomReply({
                    parentComment: paginatedContext.post as CommentIpfsWithCidDefined,
                    pkc: paginatedContext.publisherPKC,
                    commentProps: {
                        signer: paginatedSigningAuthor
                    }
                });
                paginatedContext.firstReplyDisplayName = paginatedContext.firstReply.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(paginatedContext.community as LocalCommunity, paginatedContext.firstReply);

                paginatedContext.secondReply = await publishRandomReply({
                    parentComment: paginatedContext.post as CommentIpfsWithCidDefined,
                    pkc: paginatedContext.publisherPKC,
                    commentProps: {
                        signer: paginatedSigningAuthor
                    }
                });
                paginatedContext.secondReplyDisplayName = paginatedContext.secondReply.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(paginatedContext.community as LocalCommunity, paginatedContext.secondReply);

                // Create nested replies
                paginatedContext.firstNestedReply = await publishRandomReply({
                    parentComment: paginatedContext.firstReply as CommentIpfsWithCidDefined,
                    pkc: paginatedContext.publisherPKC,
                    commentProps: {
                        signer: paginatedSigningAuthor
                    }
                });
                paginatedContext.firstNestedReplyDisplayName = paginatedContext.firstNestedReply.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(
                    paginatedContext.community as LocalCommunity,
                    paginatedContext.firstNestedReply
                );
                const { cleanup } = await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
                    community: paginatedContext.community,
                    parentComment: paginatedContext.post
                });
                paginatedForcedChunkingCleanup = cleanup;
                const { cleanup: cleanupNested } = await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
                    community: paginatedContext.community,
                    parentComment: paginatedContext.firstReply
                });
                nestedForcedChunkingCleanup = cleanupNested;

                await forceCommunityToGenerateAllPostsPages(paginatedContext.community as LocalCommunity);
                await waitTillPostInCommunityPages(paginatedContext.post as Comment & { cid: string }, paginatedContext.publisherPKC);
                await waitTillReplyInParentPages(
                    paginatedContext.firstReply as Comment & { cid: string; parentCid: string },
                    paginatedContext.publisherPKC
                );
                await waitTillReplyInParentPages(
                    paginatedContext.secondReply as Comment & { cid: string; parentCid: string },
                    paginatedContext.publisherPKC
                );
                await waitTillReplyInParentPages(
                    paginatedContext.firstNestedReply as Comment & { cid: string; parentCid: string },
                    paginatedContext.publisherPKC
                );

                // Get alias signers for verification
                const firstReplyAlias = (paginatedContext.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                    paginatedContext.firstReply.cid
                ) as AliasRow;
                const secondReplyAlias = (paginatedContext.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                    paginatedContext.secondReply.cid
                ) as AliasRow;
                const nestedReplyAlias = (paginatedContext.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                    paginatedContext.firstNestedReply.cid
                ) as AliasRow;

                expect(firstReplyAlias).to.exist;
                expect(secondReplyAlias).to.exist;
                expect(nestedReplyAlias).to.exist;

                firstReplyAliasSigner = await paginatedContext.publisherPKC.createSigner({
                    privateKey: firstReplyAlias.aliasPrivateKey,
                    type: "ed25519"
                });
                secondReplyAliasSigner = await paginatedContext.publisherPKC.createSigner({
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

            remotePKCConfigs.forEach((config) => {
                describe(`${config.name} - paginated`, () => {
                    let remotePKC: PKC;

                    beforeAll(async () => {
                        remotePKC = await config.pkcInstancePromise();
                        await waitTillPostInCommunityPages(paginatedContext.post as Comment & { cid: string }, remotePKC);
                        await waitTillReplyInParentPages(
                            paginatedContext.firstReply as Comment & { cid: string; parentCid: string },
                            remotePKC
                        );
                        await waitTillReplyInParentPages(
                            paginatedContext.secondReply as Comment & { cid: string; parentCid: string },
                            remotePKC
                        );
                        await waitTillReplyInParentPages(
                            paginatedContext.firstNestedReply as Comment & { cid: string; parentCid: string },
                            remotePKC
                        );
                    });

                    afterAll(async () => {
                        await remotePKC.destroy();
                    });

                    it.sequential("Spec: community.posts.getPage({ cid }) loads a page with anonymized comments", async () => {
                        const remoteCommunity = await remotePKC.getCommunity({ address: paginatedContext.community.address });
                        expect(Object.keys(remoteCommunity.posts.pageCids).length).to.be.greaterThan(0);

                        for (const firstPageCid of Object.values(remoteCommunity.posts.pageCids)) {
                            let currentCid: string | undefined = firstPageCid;
                            let found = false;
                            while (currentCid && !found) {
                                const page = await remoteCommunity.posts.getPage({ cid: currentCid });
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
                        const remoteParent = await remotePKC.getComment({ cid: paginatedContext.post!.cid });
                        await remoteParent.update();
                        await waitTillReplyInParentPagesInstance(
                            paginatedContext.firstReply as Required<
                                Pick<CommentIpfsWithCidDefined, "parentCid" | "cid"> & { communityAddress: string }
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
                        const remoteParent = await remotePKC.getComment({ cid: paginatedContext.post!.cid });
                        await remoteParent.update();
                        await waitTillReplyInParentPagesInstance(
                            paginatedContext.firstReply as Required<
                                Pick<CommentIpfsWithCidDefined, "parentCid" | "cid"> & { communityAddress: string }
                            >,
                            remoteParent
                        );
                        await waitTillReplyInParentPagesInstance(
                            paginatedContext.secondReply as Required<
                                Pick<CommentIpfsWithCidDefined, "parentCid" | "cid"> & { communityAddress: string }
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
                        const remoteParentReply = await remotePKC.getComment({ cid: paginatedContext.firstReply!.cid });
                        await remoteParentReply.update();
                        await waitTillReplyInParentPagesInstance(
                            paginatedContext.firstNestedReply as Required<
                                Pick<CommentIpfsWithCidDefined, "parentCid" | "cid"> & { communityAddress: string }
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
            modContext = await createPerReplyCommunity();
            modSigner = await modContext.publisherPKC.createSigner();
            regularSigner = await modContext.publisherPKC.createSigner();

            // Assign mod role
            await modContext.community.edit({ roles: { [modSigner.address]: { role: "moderator" } } });
            await resolveWhenConditionIsTrue({
                toUpdate: modContext.community,
                predicate: async () => modContext.community.roles?.[modSigner.address]?.role === "moderator"
            });
        });

        afterAll(async () => {
            await modContext.cleanup();
        });

        it("Spec: mod comment is NOT pseudonymized in per-reply mode", async () => {
            const modPost = await publishRandomPost({
                communityAddress: modContext.community.address,
                pkc: modContext.publisherPKC,
                postProps: { signer: modSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(modContext.community as LocalCommunity, modPost);

            const stored = (modContext.community as LocalCommunity)._dbHandler.queryComment(modPost.cid) as StoredComment;
            expect(stored?.author?.address).to.be.undefined;
            expect(stored?.signature?.publicKey).to.equal(modSigner.publicKey);
            expect(stored?.pseudonymityMode).to.be.undefined;

            const aliasRow = (modContext.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(modPost.cid);
            expect(aliasRow).to.be.undefined;

            await modPost.stop();
        });

        it("Spec: non-mod is still pseudonymized alongside mod in per-reply mode", async () => {
            const modPost = await publishRandomPost({
                communityAddress: modContext.community.address,
                pkc: modContext.publisherPKC,
                postProps: { signer: modSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(modContext.community as LocalCommunity, modPost);

            const regularPost = await publishRandomPost({
                communityAddress: modContext.community.address,
                pkc: modContext.publisherPKC,
                postProps: {
                    signer: regularSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(modContext.community as LocalCommunity, regularPost);

            // Mod should use real address
            const storedMod = (modContext.community as LocalCommunity)._dbHandler.queryComment(modPost.cid) as StoredComment;
            expect(storedMod?.author?.address).to.be.undefined;
            expect(storedMod?.signature?.publicKey).to.equal(modSigner.publicKey);

            // Regular user should be pseudonymized
            const storedRegular = (modContext.community as LocalCommunity)._dbHandler.queryComment(regularPost.cid) as StoredComment;
            expect(storedRegular?.author?.address).to.be.undefined;
            expect(storedRegular?.signature?.publicKey).to.not.equal(regularSigner.publicKey);

            const aliasRow = (modContext.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                regularPost.cid
            ) as AliasRow;
            expect(aliasRow).to.exist;
            expect(aliasRow.mode).to.equal("per-reply");

            await modPost.stop();
            await regularPost.stop();
        });

        it("Spec: mod comment edit uses real key in per-reply mode", async () => {
            const modPost = await publishRandomPost({
                communityAddress: modContext.community.address,
                pkc: modContext.publisherPKC,
                postProps: { signer: modSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(modContext.community as LocalCommunity, modPost);

            const editedContent = "Mod edited content - " + Date.now();
            const edit = await modContext.publisherPKC.createCommentEdit({
                communityAddress: modPost.communityAddress,
                commentCid: modPost.cid,
                content: editedContent,
                signer: modSigner
            });
            await publishWithExpectedResult({ publication: edit, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: modContext.community,
                predicate: async () =>
                    (
                        (modContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                            cid: modPost.cid
                        }) as StoredCommentUpdate
                    )?.edit?.content === editedContent
            });

            const storedUpdate = (modContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
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

async function expectCommentCidToUseAlias(pkc: PKC, cid: string, aliasSigner: { address: string; publicKey: string }): Promise<void> {
    const fetched = JSON.parse((await pkc.fetchCid({ cid })).content) as {
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
            communityAddress: context.communityAddress
        });
        const storedParentPost = await (context.community as unknown as LocalCommunityWithPrivateMethods).storePublication({
            comment: parentPost
        });
        const postCid = storedParentPost.cid;

        const originalReply = await buildSignedReplyPublication({
            signer: authorSigner,
            communityAddress: context.communityAddress,
            postCid,
            parentCid: postCid
        });
        const oldStored = await (context.community as unknown as LocalCommunityWithPrivateMethods).storePublication({
            comment: originalReply
        });
        const oldReplyCid = oldStored.cid;
        const oldAliasRow = context.dbHandler.queryPseudonymityAliasByCommentCid(oldReplyCid) as AliasRow;
        expect(oldAliasRow?.mode).to.equal(initialMode);

        const oldAliasSigner = await createSigner({ privateKey: oldAliasRow.aliasPrivateKey, type: "ed25519" });
        expectStoredCommentToUseAlias(context.dbHandler, oldReplyCid, oldAliasSigner);

        await context.community.edit({ features: { pseudonymityMode: nextMode as "per-author" | "per-post" | "per-reply" } });
        await ensureCommunityDbReady(context.community as LocalCommunity);

        const newReply = await buildSignedReplyPublication({
            signer: authorSigner,
            communityAddress: context.communityAddress,
            postCid,
            parentCid: postCid
        });
        const newReplyStored = await (context.community as unknown as LocalCommunityWithPrivateMethods).storePublication({
            comment: newReply
        });
        const newReplyAliasRow = context.dbHandler.queryPseudonymityAliasByCommentCid(newReplyStored.cid) as AliasRow;
        expect(newReplyAliasRow?.mode).to.equal(nextMode);

        const newReplyAliasSigner = await createSigner({ privateKey: newReplyAliasRow.aliasPrivateKey, type: "ed25519" });
        expect(newReplyAliasRow.aliasPrivateKey).to.not.equal(oldAliasRow.aliasPrivateKey);
        expectStoredCommentToUseAlias(context.dbHandler, newReplyStored.cid, newReplyAliasSigner);

        const newPost = await buildSignedPostPublication({
            signer: authorSigner,
            communityAddress: context.communityAddress
        });
        const newPostStored = await (context.community as unknown as LocalCommunityWithPrivateMethods).storePublication({
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
    communityAddress: communityAddress,
    postCid,
    parentCid
}: {
    signer: SignerWithPublicKeyAddress;
    communityAddress: string;
    postCid: string;
    parentCid: string;
}): Promise<CommentPubsubMessagePublication> {
    const base = {
        signer,
        communityAddress: communityAddress,
        timestamp: timestamp(),
        protocolVersion: PROTOCOL_VERSION,
        content: `transition-reply-${Date.now()}`,
        postCid,
        parentCid
    };
    const signature = await signComment({ comment: base, pkc: {} as PKC });
    const publication = { ...base, signature } as CommentPubsubMessagePublication & { signer?: SignerWithPublicKeyAddress };
    delete publication.signer;
    return publication;
}

async function buildSignedPostPublication({
    signer,
    communityAddress: communityAddress
}: {
    signer: SignerWithPublicKeyAddress;
    communityAddress: string;
}): Promise<CommentPubsubMessagePublication> {
    const base = {
        signer,
        communityAddress: communityAddress,
        timestamp: timestamp(),
        protocolVersion: PROTOCOL_VERSION,
        title: `transition-post-${Date.now()}`,
        content: `transition-post-content-${Date.now()}`
    };
    const signature = await signComment({ comment: base, pkc: {} as PKC });
    const publication = { ...base, signature } as CommentPubsubMessagePublication & { signer?: SignerWithPublicKeyAddress };
    delete publication.signer;
    return publication;
}

async function ensureCommunityDbReady(community: LocalCommunity): Promise<void> {
    if (typeof (community as unknown as LocalCommunityWithPrivateMethods).initDbHandlerIfNeeded === "function") {
        await (community as unknown as LocalCommunityWithPrivateMethods).initDbHandlerIfNeeded();
    }
    await community._dbHandler.initDbIfNeeded({ fileMustExist: false });
}

function expectStoredCommentToUseAlias(
    dbHandler: LocalCommunity["_dbHandler"],
    cid: string,
    aliasSigner: SignerWithPublicKeyAddress
): void {
    const stored = dbHandler.queryComment(cid) as StoredComment;
    expect(stored?.author?.address).to.be.undefined;
    expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
}

async function createAnonymityTransitionContext(initialMode: string): Promise<AnonymityTransitionContext> {
    const pkc = await mockPKC();
    const community = await createSubWithNoChallenge({}, pkc);
    await community.edit({ features: { pseudonymityMode: initialMode as "per-author" | "per-post" | "per-reply" } });
    await (community as LocalCommunity)._dbHandler.initDbIfNeeded({ fileMustExist: false });
    await (community as LocalCommunity)._dbHandler.createOrMigrateTablesIfNeeded();
    return {
        community,
        dbHandler: (community as LocalCommunity)._dbHandler,
        pkc,
        communityAddress: community.address,
        cleanup: async () => {
            await community.delete();
            await pkc.destroy();
        }
    };
}

async function createPerReplyCommunity(): Promise<PerReplyContext> {
    const publisherPKC = await mockPKC();
    const community = await createSubWithNoChallenge({}, publisherPKC);
    await community.edit({ features: { pseudonymityMode: "per-reply" } });
    await community.start();
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

    return {
        publisherPKC,
        community,
        cleanup: async () => {
            await community.delete();
            await publisherPKC.destroy();
        }
    };
}

async function waitForStoredCommentUpdateWithAssertions(community: LocalCommunity, comment: Comment): Promise<StoredCommentUpdate> {
    if (!comment.cid) throw new Error("waitForStoredCommentUpdateWithAssertions expects comment.cid to be defined");
    const storedUpdate = await waitForStoredCommentUpdate(community, comment.cid);
    expect(storedUpdate.cid).to.equal(comment.cid);
    expect(storedUpdate.updatedAt).to.be.a("number");
    expect(storedUpdate.replyCount).to.be.a("number");
    expect(storedUpdate.protocolVersion).to.be.a("string");
    expect(storedUpdate.signature).to.be.an("object");
    expect(storedUpdate.signature.signedPropertyNames).to.be.an("array").that.is.not.empty;
    return storedUpdate;
}

async function waitForStoredCommentUpdate(community: LocalCommunity, cid: string): Promise<StoredCommentUpdate> {
    if (!cid) throw new Error("waitForStoredCommentUpdate requires a cid");
    const timeoutMs = 60000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const stored = community._dbHandler.queryStoredCommentUpdate({ cid }) as StoredCommentUpdate | undefined;
        if (stored) return stored;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for stored comment update for ${cid}`);
}

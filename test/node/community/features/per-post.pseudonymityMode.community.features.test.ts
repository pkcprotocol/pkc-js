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
    CommentUpdatesRow
} from "../../../../dist/node/publications/comment/types.js";
import type { PseudonymityAliasRow } from "../../../../dist/node/runtime/node/community/db-handler-types.js";

const remotePKCConfigs = getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true });

interface PerPostContext {
    publisherPKC: PKC;
    community: LocalCommunity | RpcLocalCommunity;
    cleanup: () => Promise<void>;
    post?: Comment;
    reply?: Comment;
    secondPost?: Comment;
    postDisplayName?: string;
    replyDisplayName?: string;
    editContent?: string;
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

// Type to access private methods for testing purposes
interface LocalCommunityWithPrivateMethods {
    storePublication: (args: { comment: CommentPubsubMessagePublication }) => Promise<{ cid: string }>;
    initDbHandlerIfNeeded: () => Promise<void>;
    _dbHandler: LocalCommunity["_dbHandler"];
}

describeSkipIfRpc('community.features.pseudonymityMode="per-post"', () => {
    describe.concurrent("local anonymization", () => {
        let context: PerPostContext;
        let authorSigner: SignerWithPublicKeyAddress;
        let otherSigner: SignerWithPublicKeyAddress;

        beforeAll(async () => {
            context = await createPerPostCommunity();
            authorSigner = await context.publisherPKC.createSigner();
            otherSigner = await context.publisherPKC.createSigner();
        });

        afterAll(async () => {
            await context.cleanup();
        });

        it('Spec: sub re-signs comments with an anonymized author address when pseudonymityMode="per-post"', async () => {
            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(post.cid) as AliasRow;
            expect(aliasRow).to.exist;
            expect(aliasRow?.mode).to.equal("per-post");
            expect(aliasRow?.originalAuthorPublicKey).to.equal(authorSigner.publicKey);

            const aliasSigner = await context.publisherPKC.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });
            const stored = (context.community as LocalCommunity)._dbHandler.queryComment(post.cid) as StoredComment;

            expect(stored?.author?.address).to.be.undefined;
            expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            expect(stored?.signature?.publicKey).to.not.equal(authorSigner.publicKey);
            expect(stored?.pseudonymityMode).to.equal("per-post");
            await expectCommentCidToUseAlias(context.publisherPKC, post.cid, aliasSigner);

            // Verify raw.pubsubMessageToPublish has pre-pseudonymization data
            expect(post.raw.pubsubMessageToPublish?.signature?.publicKey).to.equal(authorSigner.publicKey);

            // Verify raw.comment has post-pseudonymization data
            expect(post.raw.comment?.signature?.publicKey).to.equal(aliasSigner.publicKey);

            // Verify runtime comment has post-pseudonymization data
            expect(post.author.address).to.equal(aliasSigner.address);
            expect(post.signature?.publicKey).to.equal(aliasSigner.publicKey);

            await post.stop();
        });

        it("Spec: same signer maps to the same anonymized author address within a single post thread", async () => {
            const threadSigner = await context.publisherPKC.createSigner();
            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: threadSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);
            const reply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: { signer: threadSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, reply);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                threadSigner.publicKey,
                post.cid
            ) as AliasRow;
            expect(aliasRow).to.exist;
            const aliasSigner = await context.publisherPKC.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });

            const storedPost = (context.community as LocalCommunity)._dbHandler.queryComment(post.cid) as StoredComment;
            const storedReply = (context.community as LocalCommunity)._dbHandler.queryComment(reply.cid) as StoredComment;

            [storedPost, storedReply].forEach((stored) => {
                expect(stored?.author?.address).to.be.undefined;
                expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            });
            await expectCommentCidToUseAlias(context.publisherPKC, storedPost.cid, aliasSigner);
            await expectCommentCidToUseAlias(context.publisherPKC, storedReply.cid, aliasSigner);
            expect(storedReply?.parentCid).to.equal(post.cid);
            await post.stop();
            await reply.stop();
        });

        it("Spec: two different signers never share the same anonymized author address within a single post thread", async () => {
            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const replyFromAuthor = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, replyFromAuthor);
            const replyFromOther = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: {
                    signer: otherSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, replyFromOther);

            const firstAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                authorSigner.publicKey,
                post.cid
            ) as AliasRow;
            const secondAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                otherSigner.publicKey,
                post.cid
            ) as AliasRow;

            expect(firstAlias).to.exist;
            expect(secondAlias).to.exist;

            const firstAliasSigner = await context.publisherPKC.createSigner({
                privateKey: firstAlias.aliasPrivateKey,
                type: "ed25519"
            });
            const secondAliasSigner = await context.publisherPKC.createSigner({
                privateKey: secondAlias.aliasPrivateKey,
                type: "ed25519"
            });

            expect(firstAliasSigner.address).to.not.equal(secondAliasSigner.address);
            expect(firstAlias.aliasPrivateKey).to.not.equal(secondAlias.aliasPrivateKey);
            await expectCommentCidToUseAlias(context.publisherPKC, post.cid, firstAliasSigner);
            await expectCommentCidToUseAlias(context.publisherPKC, replyFromAuthor.cid, firstAliasSigner);
            await expectCommentCidToUseAlias(context.publisherPKC, replyFromOther.cid, secondAliasSigner);
            await post.stop();
            await replyFromAuthor.stop();
            await replyFromOther.stop();
        });

        it("Spec: author.address domains resolve and are anonymized per post thread", async () => {
            const domainSigner = await context.publisherPKC.createSigner(signers[3]);
            const domainAddress = "plebbit.bso";

            const { resolvedAuthorName: resolvedAddress } = await context.publisherPKC.resolveAuthorName({ name: domainAddress });
            expect(resolvedAddress).to.equal(domainSigner.address);

            const domainPost = await context.publisherPKC.createComment({
                communityAddress: context.community.address,
                signer: domainSigner,
                author: { address: domainAddress, name: domainAddress, displayName: "Domain author" },
                content: "Domain anonymization content " + Date.now(),
                title: "Domain anonymization title " + Date.now()
            });
            await publishWithExpectedResult({ publication: domainPost, expectedChallengeSuccess: true });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, domainPost);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                domainSigner.publicKey,
                domainPost.cid
            ) as AliasRow;
            expect(aliasRow).to.exist;
            const aliasSigner = await context.publisherPKC.createSigner({
                privateKey: aliasRow.aliasPrivateKey,
                type: "ed25519"
            });

            await resolveWhenConditionIsTrue({
                toUpdate: domainPost,
                predicate: async () => domainPost.author?.address === aliasSigner.address
            });

            const stored = (context.community as LocalCommunity)._dbHandler.queryComment(domainPost.cid) as StoredComment;
            expect(stored?.author?.address).to.be.undefined;
            expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            // Verify raw.pubsubMessageToPublish has pre-pseudonymization data
            expect(domainPost.raw.pubsubMessageToPublish?.author?.name).to.equal(domainAddress);
            expect(domainPost.raw.pubsubMessageToPublish?.signature?.publicKey).to.equal(domainSigner.publicKey);

            // Verify raw.comment has post-pseudonymization data
            expect(domainPost.raw.comment?.author?.name).to.be.undefined;
            expect(domainPost.raw.comment?.signature?.publicKey).to.equal(aliasSigner.publicKey);

            // Verify runtime comment has post-pseudonymization data
            expect(domainPost.author.address).to.equal(aliasSigner.address);
            expect(domainPost.signature?.publicKey).to.equal(aliasSigner.publicKey);

            await expectCommentCidToUseAlias(context.publisherPKC, domainPost.cid, aliasSigner);

            await domainPost.stop();
        });

        it("Spec: same signer maps to a different anonymized author address across different posts", async () => {
            const firstPost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, firstPost);
            const secondPost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, secondPost);

            const firstAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                authorSigner.publicKey,
                firstPost.cid
            ) as AliasRow;
            const secondAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                authorSigner.publicKey,
                secondPost.cid
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
            await expectCommentCidToUseAlias(context.publisherPKC, firstPost.cid, firstAliasSigner);
            await expectCommentCidToUseAlias(context.publisherPKC, secondPost.cid, secondAliasSigner);
            await firstPost.stop();
            await secondPost.stop();
        });

        it("Spec: replies and edits under a post reuse that post's anonymized author mapping", async () => {
            const threadSigner = await context.publisherPKC.createSigner();
            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: threadSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);
            const reply = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                pkc: context.publisherPKC,
                commentProps: { signer: threadSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, reply);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                threadSigner.publicKey,
                post.cid
            ) as AliasRow;
            expect(aliasRow).to.exist;
            const aliasSigner = await context.publisherPKC.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });

            const editedContent = "Edited content " + Date.now();
            const edit = await context.publisherPKC.createCommentEdit({
                communityAddress: post.communityAddress,
                commentCid: post.cid,
                content: editedContent,
                signer: threadSigner
            });
            await publishWithExpectedResult({ publication: edit, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: context.community,
                predicate: async () =>
                    ((context.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({ cid: post.cid }) as StoredCommentUpdate)
                        ?.edit?.content === editedContent
            });

            const storedPost = (context.community as LocalCommunity)._dbHandler.queryComment(post.cid) as StoredComment;
            const storedReply = (context.community as LocalCommunity)._dbHandler.queryComment(reply.cid) as StoredComment;
            expect(storedPost?.author?.address).to.be.undefined;
            expect(storedReply?.author?.address).to.be.undefined;
            await expectCommentCidToUseAlias(context.publisherPKC, storedPost.cid, aliasSigner);
            await expectCommentCidToUseAlias(context.publisherPKC, storedReply.cid, aliasSigner);

            const storedUpdate = (context.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                cid: post.cid
            }) as StoredCommentUpdate;
            expect(storedUpdate?.edit?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            await post.stop();
            await reply.stop();
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
            const noisyPost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: {
                    author: noisyAuthor,
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, noisyPost);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                authorSigner.publicKey,
                noisyPost.cid
            ) as AliasRow;
            const aliasSigner = await context.publisherPKC.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });

            const stored = (context.community as LocalCommunity)._dbHandler.queryComment(noisyPost.cid) as StoredComment;
            expect(stored?.author).to.deep.equal({ displayName: noisyAuthor.displayName });
            expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            await expectCommentCidToUseAlias(context.publisherPKC, noisyPost.cid, aliasSigner);
            await noisyPost.stop();
        });

        it("Spec: anonymized publication omits author.previousCommentCid", async () => {
            const chainAuthor = await context.publisherPKC.createSigner();
            const previousPost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: chainAuthor }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, previousPost);

            const chainedPost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: {
                    signer: chainAuthor,
                    author: { previousCommentCid: previousPost.cid, address: chainAuthor.address }
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, chainedPost);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                chainAuthor.publicKey,
                chainedPost.cid
            ) as AliasRow;
            const aliasSigner = await context.publisherPKC.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });
            const stored = (context.community as LocalCommunity)._dbHandler.queryComment(chainedPost.cid) as StoredComment;
            expect(stored?.author?.previousCommentCid).to.be.undefined;
            expect(stored?.author?.address).to.be.undefined;
            await expectCommentCidToUseAlias(context.publisherPKC, chainedPost.cid, aliasSigner);
            await previousPost.stop();
            await chainedPost.stop();
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
            const originalTitle = "Title before anonymization";

            const authoredPost = await context.publisherPKC.createComment({
                communityAddress: context.community.address,
                signer: authorSigner,
                author: originalAuthor,
                content: originalContent,
                title: originalTitle
            });
            await publishWithExpectedResult({ publication: authoredPost, expectedChallengeSuccess: true });
            expect(authoredPost.raw.pubsubMessageToPublish).to.be.ok;
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, authoredPost);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                authorSigner.publicKey,
                authoredPost.cid
            ) as AliasRow;
            expect(aliasRow).to.exist;
            const alias = await context.publisherPKC.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });
            const rawPubsub = () => authoredPost.raw.pubsubMessageToPublish;
            const expectOriginalFields = () => {
                expect(rawPubsub()?.author?.displayName).to.equal(originalAuthor.displayName);
                expect(rawPubsub()?.author?.wallets).to.deep.equal(originalAuthor.wallets);
                expect(rawPubsub()?.author?.flairs).to.deep.equal(originalAuthor.flairs);
                expect(rawPubsub()?.author?.previousCommentCid).to.equal(originalAuthor.previousCommentCid);
                expect(rawPubsub()?.content).to.equal(originalContent);
                expect(rawPubsub()?.signature?.publicKey).to.equal(authorSigner.publicKey);
            };

            const stored = (context.community as LocalCommunity)._dbHandler.queryComment(authoredPost.cid) as StoredComment;
            expect(stored?.author?.address).to.be.undefined;
            expect(stored?.signature?.publicKey).to.equal(alias.publicKey);
            await expectCommentCidToUseAlias(context.publisherPKC, authoredPost.cid, alias);
            expectOriginalFields();

            // Verify raw.comment has alias (post-pseudonymization) data
            expect(authoredPost.raw.comment).to.be.ok;
            expect(authoredPost.raw.comment!.signature?.publicKey).to.equal(alias.publicKey);
            expect(authoredPost.raw.comment!.author?.displayName).to.equal(originalAuthor.displayName);
            expect(authoredPost.raw.comment!.author?.wallets).to.be.undefined;
            expect(authoredPost.raw.comment!.author?.flairs).to.be.undefined;
            expect(authoredPost.raw.comment!.author?.previousCommentCid).to.be.undefined;

            // Verify runtime comment has alias (post-pseudonymization) signature
            expect(authoredPost.signature?.publicKey).to.equal(alias.publicKey);

            await authoredPost.update();

            expect(authoredPost.author.address).to.equal(alias.address);
            expect(authoredPost.author.displayName).to.equal(originalAuthor.displayName);

            expectOriginalFields();

            await authoredPost.stop();
        });

        it("Spec: comment edit signed by original author is accepted and re-signed with anonymized author key", async () => {
            const editSigner = await context.publisherPKC.createSigner();
            const editablePost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: editSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, editablePost);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                editSigner.publicKey,
                editablePost.cid
            ) as AliasRow;
            expect(aliasRow).to.exist;
            const aliasSigner = await context.publisherPKC.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });

            const editedContent = "Edited content - " + Date.now();
            const edit = await context.publisherPKC.createCommentEdit({
                communityAddress: editablePost.communityAddress,
                commentCid: editablePost.cid,
                content: editedContent,
                signer: editSigner
            });
            await publishWithExpectedResult({ publication: edit, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: context.community,
                predicate: async () =>
                    (
                        (context.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                            cid: editablePost.cid
                        }) as StoredCommentUpdate
                    )?.edit?.content === editedContent
            });

            const storedUpdate = (context.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                cid: editablePost.cid
            }) as StoredCommentUpdate;
            expect(storedUpdate?.edit?.content).to.equal(editedContent);
            expect(storedUpdate?.edit?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            const storedComment = (context.community as LocalCommunity)._dbHandler.queryComment(editablePost.cid) as StoredComment;
            expect(storedComment?.author?.address).to.be.undefined;
            await expectCommentCidToUseAlias(context.publisherPKC, editablePost.cid, aliasSigner);
            await editablePost.stop();
        });

        it("Spec: comment edit is rejected when original author does not match stored anonymization mapping", async () => {
            const ownerSigner = await context.publisherPKC.createSigner();
            const intruderSigner = await context.publisherPKC.createSigner();
            const targetPost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: ownerSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, targetPost);

            const badEdit = await context.publisherPKC.createCommentEdit({
                communityAddress: targetPost.communityAddress,
                commentCid: targetPost.cid,
                content: "Unauthorized edit " + Date.now(),
                signer: intruderSigner
            });
            await publishWithExpectedResult({
                publication: badEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_EDIT_CAN_NOT_EDIT_COMMENT_IF_NOT_ORIGINAL_AUTHOR
            });

            const storedUpdate = (context.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({ cid: targetPost.cid }) as
                | StoredCommentUpdate
                | undefined;
            expect(storedUpdate?.edit).to.be.undefined;
            await targetPost.stop();
        });

        it("Spec: anonymized comment.signature.publicKey differs from original author's signer publicKey", async () => {
            const freshSigner = await context.publisherPKC.createSigner();
            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: freshSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const stored = (context.community as LocalCommunity)._dbHandler.queryComment(post.cid) as StoredComment;
            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(post.cid) as AliasRow;
            expect(aliasRow).to.exist;
            const aliasSigner = await context.publisherPKC.createSigner({
                privateKey: aliasRow.aliasPrivateKey,
                type: "ed25519"
            });
            expect(stored?.signature?.publicKey).to.not.equal(freshSigner.publicKey);
            expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            expect(stored?.author?.address).to.be.undefined;
            await expectCommentCidToUseAlias(context.publisherPKC, post.cid, aliasSigner);
            await post.stop();
        });

        it("Spec: purging an anonymized post without postCid still removes its alias mapping", async () => {
            const purgeSigner = await context.publisherPKC.createSigner();
            // publish post, alias will be generated without postCid available to reuse
            const post = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: purgeSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, post);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(post.cid);
            expect(aliasRow).to.exist;

            await (context.community as LocalCommunity)._dbHandler.purgeComment(post.cid);

            const aliasAfterPurge = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(post.cid);
            expect(aliasAfterPurge).to.be.undefined;
            const commentAfterPurge = (context.community as LocalCommunity)._dbHandler.queryComment(post.cid);
            expect(commentAfterPurge).to.be.undefined;
            await post.stop();
        });

        it("Spec: purging an anonymized comment removes only that thread's alias mapping", async () => {
            const purgeSigner = await context.publisherPKC.createSigner();
            const firstPost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: purgeSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, firstPost);
            const secondPost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: purgeSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, secondPost);

            const aliasFirst = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(firstPost.cid);
            const aliasSecond = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(secondPost.cid);
            expect(aliasFirst).to.exist;
            expect(aliasSecond).to.exist;

            await (context.community as LocalCommunity)._dbHandler.purgeComment(firstPost.cid);

            const aliasAfterFirstPurge = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(firstPost.cid);
            expect(aliasAfterFirstPurge).to.be.undefined;
            const aliasAfterSecond = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(secondPost.cid);
            expect(aliasAfterSecond).to.exist;

            const commentAfterPurge = (context.community as LocalCommunity)._dbHandler.queryComment(firstPost.cid);
            expect(commentAfterPurge).to.be.undefined;
            await firstPost.stop();
            await secondPost.stop();
        });

        it("Spec: sub owner can resolve an anonymized author address back to the original author address", async () => {
            const resolvablePost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, resolvablePost);

            const aliasRow = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                authorSigner.publicKey,
                resolvablePost.cid
            ) as AliasRow;
            expect(aliasRow).to.exist;
            expect(aliasRow?.originalAuthorPublicKey).to.equal(authorSigner.publicKey);

            const aliasSigner = await context.publisherPKC.createSigner({
                privateKey: aliasRow.aliasPrivateKey,
                type: "ed25519"
            });
            expect(aliasSigner.address).to.be.a("string");
            await resolvablePost.stop();
        });

        it("Spec: owner resolution differentiates multiple anonymized addresses created by the same signer across different posts", async () => {
            const firstPost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, firstPost);
            const secondPost = await publishRandomPost({
                communityAddress: context.community.address,
                pkc: context.publisherPKC,
                postProps: { signer: authorSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.community as LocalCommunity, secondPost);

            const firstAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                authorSigner.publicKey,
                firstPost.cid
            ) as AliasRow;
            const secondAlias = (context.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                authorSigner.publicKey,
                secondPost.cid
            ) as AliasRow;
            expect(firstAlias).to.exist;
            expect(secondAlias).to.exist;
            expect(firstAlias?.originalAuthorPublicKey).to.equal(authorSigner.publicKey);
            expect(secondAlias?.originalAuthorPublicKey).to.equal(authorSigner.publicKey);

            const firstAliasSigner = await context.publisherPKC.createSigner({
                privateKey: firstAlias.aliasPrivateKey,
                type: "ed25519"
            });
            const secondAliasSigner = await context.publisherPKC.createSigner({
                privateKey: secondAlias.aliasPrivateKey,
                type: "ed25519"
            });

            expect(firstAliasSigner.address).to.not.equal(secondAliasSigner.address);
            await firstPost.stop();
            await secondPost.stop();
        });

        it("Spec: disabling per-post anonymity stops anonymization for new comments without rewriting old ones", async () => {
            const localContext = await createPerPostCommunity();
            const plainSigner = await localContext.publisherPKC.createSigner();
            let plainPost: Comment | undefined;

            try {
                await localContext.community.edit({ features: { pseudonymityMode: undefined } });
                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () => localContext.community.features?.pseudonymityMode === undefined
                });

                plainPost = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: plainSigner
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, plainPost);

                const stored = (localContext.community as LocalCommunity)._dbHandler.queryComment(plainPost.cid) as StoredComment;
                expect(stored?.author?.address).to.be.undefined;
                expect(stored?.signature?.publicKey).to.equal(plainSigner.publicKey);
                expect(stored?.pseudonymityMode).to.be.undefined;
                const alias = (localContext.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(plainPost.cid);
                expect(alias).to.be.undefined;
            } finally {
                await plainPost?.stop();
                await localContext.cleanup();
            }
        });

        it("Spec: challengerequest emits full publication author.community fields without anonymization in per-post mode", async () => {
            const localContext = await createPerPostCommunity();
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

                const upvote = await localContext.publisherPKC.createVote({
                    communityAddress: localContext.community.address,
                    commentCid: seededPost.cid,
                    vote: 1,
                    signer: voter
                });
                await publishWithExpectedResult({ publication: upvote, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () => {
                        const aggregated = (localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(localAuthor.address);
                        return (
                            aggregated?.lastCommentCid === seededPost.cid &&
                            aggregated?.firstCommentTimestamp === seededPost.timestamp &&
                            aggregated?.postScore === 1 &&
                            aggregated?.replyScore === 0
                        );
                    }
                });

                const communityAuthorBefore = (localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(
                    localAuthor.address
                );
                expect(communityAuthorBefore, "expected community author to exist for original signer").to.be.ok;
                expect(communityAuthorBefore.lastCommentCid).to.equal(seededPost.cid);
                expect(communityAuthorBefore.firstCommentTimestamp).to.equal(seededPost.timestamp);
                expect(communityAuthorBefore.postScore).to.equal(1);
                expect(communityAuthorBefore.replyScore).to.equal(0);

                const challengeRequestPromise = new Promise<DecryptedChallengeRequestMessageTypeWithCommunityAuthor>((resolve) =>
                    localContext.community.once("challengerequest", resolve)
                );
                const publication = await localContext.publisherPKC.createComment({
                    communityAddress: localContext.community.address,
                    signer: localAuthor,
                    content: "per-post challengerequest author.community check",
                    title: "per-post challengerequest author.community check"
                });
                await publishWithExpectedResult({ publication: publication, expectedChallengeSuccess: true });

                const challengerequest = await challengeRequestPromise;
                expect(challengerequest.comment?.author.address).to.equal(localAuthor.address);
                expect(challengerequest.comment?.author.community).to.deep.equal(communityAuthorBefore);
                expect(challengerequest.comment?.author.community?.lastCommentCid).to.equal(seededPost.cid);
                expect(challengerequest.comment?.author.community?.firstCommentTimestamp).to.equal(seededPost.timestamp);
                expect(challengerequest.comment?.author.community?.postScore).to.equal(1);
                expect(challengerequest.comment?.author.community?.replyScore).to.equal(0);

                await seededPost.stop();
                await publication.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.community.lastCommentCid reflects the author's latest comment within the post when pseudonymityMode is per-post", async () => {
            const localContext = await createPerPostCommunity();
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
                expect(postUpdate?.author?.community?.lastCommentCid).to.equal(reply.cid);
                expect(replyUpdate?.author?.community?.lastCommentCid).to.equal(reply.cid);
                const aggregatedAuthor = (localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(localAuthor.address);
                expect(aggregatedAuthor?.lastCommentCid).to.equal(reply.cid);

                await post.stop();
                await reply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.community.banExpiresAt rejects publications and only surfaces on the author's post and replies within their post thread", async () => {
            const localContext = await createPerPostCommunity();
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

                const otherPost = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, otherPost);

                const banExpiresAt = timestamp() + 60;
                const banModeration = await localContext.publisherPKC.createCommentModeration({
                    communityAddress: localContext.community.address,
                    commentCid: post.cid,
                    commentModeration: { author: { banExpiresAt }, reason: "ban for per-post test" },
                    signer: moderator
                });
                await publishWithExpectedResult({ publication: banModeration, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () =>
                        (localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(localAuthor.address)?.banExpiresAt ===
                        banExpiresAt
                });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () => {
                        const postUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                            cid: post.cid
                        }) as StoredCommentUpdate;
                        const replyUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                            cid: reply.cid
                        }) as StoredCommentUpdate;
                        return (
                            postUpdate?.author?.community?.banExpiresAt === banExpiresAt &&
                            replyUpdate?.author?.community?.banExpiresAt === banExpiresAt
                        );
                    }
                });

                const otherPostUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: otherPost.cid
                }) as StoredCommentUpdate;
                expect(otherPostUpdate?.author?.community?.banExpiresAt).to.be.undefined;

                const blockedReply = await localContext.publisherPKC.createComment({
                    communityAddress: localContext.community.address,
                    signer: localAuthor,
                    title: "should be rejected",
                    content: "should be rejected"
                });
                await publishWithExpectedResult({
                    publication: blockedReply,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_AUTHOR_IS_BANNED
                });

                await post.stop();
                await reply.stop();
                await otherPost.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: banning an anonymized comment maps to original and alias author addresses in per-post mode", async () => {
            const localContext = await createPerPostCommunity();
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

                const aliasRow = (localContext.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                    localAuthor.publicKey,
                    post.cid
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
                    commentCid: post.cid,
                    commentModeration: { author: { banExpiresAt }, reason: "ban alias mapping test" },
                    signer: moderator
                });
                await publishWithExpectedResult({ publication: banModeration, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () => {
                        const originalAuthor = (localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(
                            localAuthor.address
                        );
                        const aliasAuthor = (localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(aliasSigner.address);
                        return originalAuthor?.banExpiresAt === banExpiresAt && aliasAuthor?.banExpiresAt === banExpiresAt;
                    }
                });

                const originalAuthor = (localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(localAuthor.address);
                const aliasAuthor = (localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(aliasSigner.address);
                expect(originalAuthor?.banExpiresAt).to.equal(banExpiresAt);
                expect(aliasAuthor?.banExpiresAt).to.equal(banExpiresAt);

                await post.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.community.postScore reflects total post karma when pseudonymityMode is per-post", async () => {
            const localContext = await createPerPostCommunity();
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
                        (
                            (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                                cid: post.cid
                            }) as StoredCommentUpdate
                        )?.author?.community?.postScore === 1
                });

                const reply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    pkc: localContext.publisherPKC,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                const secondPost = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, reply);
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, secondPost);

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () => {
                        const replyUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                            cid: reply.cid
                        }) as StoredCommentUpdate;
                        const secondPostUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                            cid: secondPost.cid
                        }) as StoredCommentUpdate;
                        return replyUpdate?.author?.community?.postScore === 1 && secondPostUpdate?.author?.community?.postScore === 0;
                    }
                });

                const postUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                expect(postUpdate?.author?.community?.postScore).to.equal(1);
                const replyUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: reply.cid
                }) as StoredCommentUpdate;
                expect(replyUpdate?.author?.community?.postScore).to.equal(1);
                const secondPostUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: secondPost.cid
                }) as StoredCommentUpdate;
                expect(secondPostUpdate?.author?.community?.postScore).to.equal(0);

                await reply.stop();
                await secondPost.stop();
                await post.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.community.replyScore reflects total replies karma inside the post when pseudonymityMode is per-post", async () => {
            const localContext = await createPerPostCommunity();
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
                            (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                                cid: reply.cid
                            }) as StoredCommentUpdate
                        )?.author?.community?.replyScore === 1
                });

                const postUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                const replyUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: reply.cid
                }) as StoredCommentUpdate;
                expect(postUpdate?.author?.community?.replyScore).to.equal(1);
                expect(replyUpdate?.author?.community?.replyScore).to.equal(1);

                await post.stop();
                await reply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.community karma is NOT shared across different threads when pseudonymityMode is per-post", async () => {
            // In per-post mode, each thread has its own alias
            // Karma from thread1 should NOT appear in thread2's author.community

            const localContext = await createPerPostCommunity();
            const localAuthor = await localContext.publisherPKC.createSigner();
            const voter = await localContext.publisherPKC.createSigner();

            try {
                // Create first thread (post1) and upvote it
                const post1 = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, post1);

                const upvotePost1 = await localContext.publisherPKC.createVote({
                    communityAddress: localContext.community.address,
                    commentCid: post1.cid,
                    vote: 1,
                    signer: voter
                });
                await publishWithExpectedResult({ publication: upvotePost1, expectedChallengeSuccess: true });

                // Wait for post1 to have postScore = 1
                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () => {
                        const update = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                            cid: post1.cid
                        }) as StoredCommentUpdate | undefined;
                        return update?.author?.community?.postScore === 1;
                    }
                });

                // Create second thread (post2) - different alias
                const post2 = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, post2);

                // Verify post1's alias has postScore = 1
                const post1Update = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: post1.cid
                }) as StoredCommentUpdate;
                expect(post1Update?.author?.community?.postScore).to.equal(1);

                // Verify post2's alias has postScore = 0 (not shared from post1)
                const post2Update = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: post2.cid
                }) as StoredCommentUpdate;
                expect(post2Update?.author?.community?.postScore).to.equal(0);
                expect(post2Update?.author?.community?.replyScore).to.equal(0);

                // Verify they have different aliases by checking the alias private keys
                const post1Alias = (localContext.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                    post1.cid
                ) as AliasRow;
                const post2Alias = (localContext.community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(
                    post2.cid
                ) as AliasRow;
                expect(post1Alias).to.exist;
                expect(post2Alias).to.exist;
                expect(post1Alias.aliasPrivateKey).to.not.equal(post2Alias.aliasPrivateKey);

                await post1.stop();
                await post2.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.community.firstCommentTimestamp tracks the first author comment inside the post when pseudonymityMode is per-post", async () => {
            const localContext = await createPerPostCommunity();
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
                expect(postUpdate?.author?.community?.firstCommentTimestamp).to.equal(post.timestamp);
                expect(replyUpdate?.author?.community?.firstCommentTimestamp).to.equal(post.timestamp);
                const aggregatedAuthor = (localContext.community as LocalCommunity)._dbHandler.queryCommunityAuthor(localAuthor.address);
                expect(aggregatedAuthor?.firstCommentTimestamp).to.equal(post.timestamp);

                await post.stop();
                await reply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.community in CommentUpdate does NOT include karma from original author's prior comments when pseudonymityMode is per-post", async () => {
            // This test verifies that enabling pseudonymity mode doesn't leak prior karma into new aliases
            // 1. Author builds karma without pseudonymity mode
            // 2. Enable pseudonymity mode
            // 3. Author publishes new post (gets an alias for that thread)
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
                await community.edit({ features: { pseudonymityMode: "per-post" } });
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => community.features?.pseudonymityMode === "per-post"
                });

                // Step 3: Author publishes a new post (gets an alias for this thread)
                const pseudonymousPost = await publishRandomPost({
                    communityAddress: community.address,
                    pkc: pkc,
                    postProps: { signer: author }
                });
                await waitForStoredCommentUpdateWithAssertions(community as LocalCommunity, pseudonymousPost);

                // Step 4: Verify the alias's CommentUpdate shows isolated karma (0), not original author's karma (1)
                const postUpdate = (community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                    cid: pseudonymousPost.cid
                }) as StoredCommentUpdate;

                // The alias should have its own isolated karma, not the original author's karma
                expect(postUpdate?.author?.community?.postScore).to.equal(0);
                expect(postUpdate?.author?.community?.replyScore).to.equal(0);

                // Verify the alias is different from the original author
                const aliasRow = (community as LocalCommunity)._dbHandler.queryPseudonymityAliasByCommentCid(pseudonymousPost.cid);
                expect(aliasRow).to.exist;
                expect(aliasRow?.originalAuthorPublicKey).to.equal(author.publicKey);

                // Double-check: original author's karma should still be 1
                const originalAuthorKarmaAfter = (community as LocalCommunity)._dbHandler.queryCommunityAuthor(author.address);
                expect(originalAuthorKarmaAfter?.postScore).to.equal(1);

                await nonPseudonymousPost.stop();
                await pseudonymousPost.stop();
            } finally {
                await community.stop();
                await pkc.destroy();
            }
        });

        it("Spec: banning an author reply in per-post mode includes banExpiresAt on that thread's comments and blocks further replies", async () => {
            const localContext = await createPerPostCommunity();
            const localAuthor = await localContext.publisherPKC.createSigner();
            const moderator = await localContext.publisherPKC.createSigner();

            await localContext.community.edit({ roles: { [moderator.address]: { role: "moderator" } } });
            await resolveWhenConditionIsTrue({
                toUpdate: localContext.community,
                predicate: async () => typeof localContext.community.updatedAt === "number"
            });

            try {
                const postOne = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, postOne);
                const replyOne = await publishRandomReply({
                    parentComment: postOne as CommentIpfsWithCidDefined,
                    pkc: localContext.publisherPKC,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, replyOne);

                const postTwo = await publishRandomPost({
                    communityAddress: localContext.community.address,
                    pkc: localContext.publisherPKC,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.community as LocalCommunity, postTwo);

                const banExpiresAt = timestamp() + 60;
                const banModeration = await localContext.publisherPKC.createCommentModeration({
                    communityAddress: localContext.community.address,
                    commentCid: replyOne.cid,
                    commentModeration: { author: { banExpiresAt }, reason: "ban reply per-post test" },
                    signer: moderator
                });
                await publishWithExpectedResult({ publication: banModeration, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.community,
                    predicate: async () => {
                        const postUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                            cid: postOne.cid
                        }) as StoredCommentUpdate;
                        const replyUpdate = (localContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
                            cid: replyOne.cid
                        }) as StoredCommentUpdate;
                        return (
                            postUpdate?.author?.community?.banExpiresAt === banExpiresAt &&
                            replyUpdate?.author?.community?.banExpiresAt === banExpiresAt
                        );
                    }
                });

                const blockedReply = await localContext.publisherPKC.createComment({
                    communityAddress: localContext.community.address,
                    signer: localAuthor,
                    parentCid: postOne.cid,
                    postCid: postOne.cid,
                    content: "blocked in post one"
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

                await postOne.stop();
                await replyOne.stop();
                await postTwo.stop();
            } finally {
                await localContext.cleanup();
            }
        });
    });

    describe.sequential("duplicate comment regression", () => {
        let context: PerPostContext;
        let duplicateSigner: SignerWithPublicKeyAddress;

        const clonePublication = <T>(value: T): T => JSON.parse(JSON.stringify(value));

        beforeAll(async () => {
            context = await createPerPostCommunity();
            duplicateSigner = await context.publisherPKC.createSigner();
        });

        afterAll(async () => {
            await context.cleanup();
        });

        it("Spec: rejects duplicate post publication in per-post pseudonymity mode", async () => {
            let originalPost: Comment | undefined;
            let duplicatePost: Comment | undefined;

            try {
                originalPost = await context.publisherPKC.createComment({
                    communityAddress: context.community.address,
                    signer: duplicateSigner,
                    title: `duplicate-per-post-title-${Date.now()}`,
                    content: `duplicate-per-post-content-${Date.now()}`
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

        it("Spec: rejects duplicate reply publication in per-post pseudonymity mode", async () => {
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
                    content: `duplicate-per-post-reply-${Date.now()}`
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
            let sharedContext: PerPostContext;
            let aliasSigner: SignerWithPublicKeyAddress;
            let signingAuthor: SignerWithPublicKeyAddress;

            beforeAll(async () => {
                sharedContext = await createPerPostCommunity();
                signingAuthor = await sharedContext.publisherPKC.createSigner();
                sharedContext.post = await publishRandomPost({
                    communityAddress: sharedContext.community.address,
                    pkc: sharedContext.publisherPKC,
                    postProps: {
                        signer: signingAuthor
                    }
                });
                sharedContext.postDisplayName = sharedContext.post.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(sharedContext.community as LocalCommunity, sharedContext.post);
                sharedContext.reply = await publishRandomReply({
                    parentComment: sharedContext.post as CommentIpfsWithCidDefined,
                    pkc: sharedContext.publisherPKC,
                    commentProps: {
                        signer: signingAuthor
                    }
                });
                sharedContext.replyDisplayName = sharedContext.reply.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(sharedContext.community as LocalCommunity, sharedContext.reply);
                await waitTillPostInCommunityPages(sharedContext.post as Comment & { cid: string }, sharedContext.publisherPKC);
                await waitTillReplyInParentPages(
                    sharedContext.reply as Comment & { cid: string; parentCid: string },
                    sharedContext.publisherPKC
                );

                const aliasRow = (sharedContext.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                    signingAuthor.publicKey,
                    sharedContext.post.cid
                ) as AliasRow;
                expect(aliasRow).to.exist;
                aliasSigner = await sharedContext.publisherPKC.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });

                sharedContext.editContent = "Edited content for remote per-post " + Date.now();
                const edit = await sharedContext.publisherPKC.createCommentEdit({
                    communityAddress: sharedContext.community.address,
                    commentCid: sharedContext.post.cid,
                    content: sharedContext.editContent,
                    signer: signingAuthor
                });
                await publishWithExpectedResult({ publication: edit, expectedChallengeSuccess: true });
                await resolveWhenConditionIsTrue({
                    toUpdate: sharedContext.community,
                    predicate: async () =>
                        (
                            (sharedContext.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({
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

            remotePKCConfigs.forEach((config) => {
                describe(`${config.name} - preloaded`, () => {
                    let remotePKC: PKC;

                    beforeAll(async () => {
                        remotePKC = await config.pkcInstancePromise();
                        await waitTillPostInCommunityPages(sharedContext.post! as Comment & { cid: string }, remotePKC);
                        await waitTillReplyInParentPages(sharedContext.reply! as Comment & { cid: string; parentCid: string }, remotePKC);
                    });

                    afterAll(async () => {
                        await remotePKC.destroy();
                    });

                    it("Spec: loads preloaded pages with anonymized posts/replies without failing verification", async () => {
                        const remoteCommunity = await remotePKC.getCommunity({ address: sharedContext.community.address });
                        expect(Object.keys(remoteCommunity.posts.pages).length).to.be.greaterThan(0);
                        for (const sortName of Object.keys(remoteCommunity.posts.pages)) {
                            const page = remoteCommunity.posts.pages[sortName];
                            const postInPage = page?.comments?.find((c) => c.cid === sharedContext.post!.cid);
                            expect(postInPage).to.be.ok;
                            expect(postInPage?.author?.address).to.equal(aliasSigner.address);
                            expect(postInPage?.author?.displayName).to.equal(sharedContext.postDisplayName);
                            expect(postInPage?.author?.wallets).to.be.undefined;
                            expect(postInPage?.author?.flairs).to.be.undefined;
                            expect(postInPage?.signature?.publicKey).to.equal(aliasSigner.publicKey);
                            expect(postInPage?.pseudonymityMode).to.equal("per-post");
                        }
                    });

                    it("Spec: getComment returns an anonymized post/reply and keeps per-post alias stable on update", async () => {
                        const remoteComment = await remotePKC.getComment({ cid: sharedContext.post!.cid });
                        await remoteComment.update();
                        await resolveWhenConditionIsTrue({
                            toUpdate: remoteComment,
                            predicate: async () =>
                                typeof remoteComment.updatedAt === "number" &&
                                remoteComment.edit?.content === sharedContext.editContent &&
                                remoteComment.content === sharedContext.editContent
                        });
                        expect(remoteComment.author.address).to.equal(aliasSigner.address);
                        expect(remoteComment.author.displayName).to.equal(sharedContext.postDisplayName);
                        expect(remoteComment.content).to.equal(sharedContext.editContent);
                        expect(remoteComment.edit?.content).to.equal(sharedContext.editContent);
                        expect(remoteComment.edit?.signature?.publicKey).to.equal(aliasSigner.publicKey);
                        expect(remoteComment.signature.publicKey).to.equal(aliasSigner.publicKey);
                        expect(remoteComment.pseudonymityMode).to.equal("per-post");
                        await remoteComment.stop();
                    });

                    it("Spec: comment.update() on an anonymized reply keeps per-post alias and signature verification passing", async () => {
                        const remoteReply = await remotePKC.getComment({ cid: sharedContext.reply!.cid });
                        await remoteReply.update();
                        await resolveWhenConditionIsTrue({
                            toUpdate: remoteReply,
                            predicate: async () => typeof remoteReply.updatedAt === "number"
                        });
                        expect(remoteReply.author.address).to.equal(aliasSigner.address);
                        expect(remoteReply.signature.publicKey).to.equal(aliasSigner.publicKey);
                        await remoteReply.stop();
                    });
                });
            });
        });

        describe.sequential("paginated pages", () => {
            let paginatedContext: PerPostContext;
            let paginatedAliasSigner: SignerWithPublicKeyAddress;
            let paginatedSigningAuthor: SignerWithPublicKeyAddress;
            let secondPostAliasSigner: SignerWithPublicKeyAddress;

            beforeAll(async () => {
                paginatedContext = await createPerPostCommunity();
                paginatedSigningAuthor = await paginatedContext.publisherPKC.createSigner();
                paginatedContext.post = await publishRandomPost({
                    communityAddress: paginatedContext.community.address,
                    pkc: paginatedContext.publisherPKC,
                    postProps: {
                        signer: paginatedSigningAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(paginatedContext.community as LocalCommunity, paginatedContext.post);
                paginatedContext.reply = await publishRandomReply({
                    parentComment: paginatedContext.post as CommentIpfsWithCidDefined,
                    pkc: paginatedContext.publisherPKC,
                    commentProps: {
                        signer: paginatedSigningAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(paginatedContext.community as LocalCommunity, paginatedContext.reply);

                paginatedContext.secondPost = await publishRandomPost({
                    communityAddress: paginatedContext.community.address,
                    pkc: paginatedContext.publisherPKC,
                    postProps: {
                        signer: paginatedSigningAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(paginatedContext.community as LocalCommunity, paginatedContext.secondPost);

                await forceCommunityToGenerateAllPostsPages(paginatedContext.community);
                await waitTillPostInCommunityPages(paginatedContext.post as Comment & { cid: string }, paginatedContext.publisherPKC);
                await waitTillPostInCommunityPages(paginatedContext.secondPost as Comment & { cid: string }, paginatedContext.publisherPKC);
                await waitTillReplyInParentPages(
                    paginatedContext.reply as Comment & { cid: string; parentCid: string },
                    paginatedContext.publisherPKC
                );

                const aliasRow = (paginatedContext.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                    paginatedSigningAuthor.publicKey,
                    paginatedContext.post.cid
                ) as AliasRow;
                const secondAliasRow = (paginatedContext.community as LocalCommunity)._dbHandler.queryPseudonymityAliasForPost(
                    paginatedSigningAuthor.publicKey,
                    paginatedContext.secondPost.cid
                ) as AliasRow;
                expect(aliasRow).to.exist;
                expect(secondAliasRow).to.exist;
                paginatedAliasSigner = await paginatedContext.publisherPKC.createSigner({
                    privateKey: aliasRow.aliasPrivateKey,
                    type: "ed25519"
                });
                secondPostAliasSigner = await paginatedContext.publisherPKC.createSigner({
                    privateKey: secondAliasRow.aliasPrivateKey,
                    type: "ed25519"
                });
            });

            afterAll(async () => {
                await paginatedContext?.post?.stop();
                await paginatedContext?.reply?.stop();
                await paginatedContext?.secondPost?.stop();
                await paginatedContext?.cleanup();
            });

            remotePKCConfigs.forEach((config) => {
                describe.concurrent(`${config.name} - paginated`, () => {
                    let remotePKC: PKC;

                    beforeAll(async () => {
                        remotePKC = await config.pkcInstancePromise();
                        await waitTillPostInCommunityPages(paginatedContext.post! as Comment & { cid: string }, remotePKC);
                        await waitTillPostInCommunityPages(paginatedContext.secondPost! as Comment & { cid: string }, remotePKC);
                        await waitTillReplyInParentPages(
                            paginatedContext.reply! as Comment & { cid: string; parentCid: string },
                            remotePKC
                        );
                    });

                    afterAll(async () => {
                        await remotePKC?.destroy();
                    });

                    it("Spec: community.posts.getPage({ cid }) loads a page with anonymized comments", async () => {
                        const remoteCommunity = await remotePKC.getCommunity({ address: paginatedContext.community.address });
                        expect(Object.keys(remoteCommunity.posts.pageCids).length).to.be.greaterThan(0);
                        for (const firstPageCid of Object.values(remoteCommunity.posts.pageCids)) {
                            let currentCid: string | undefined = firstPageCid;
                            let found = false;
                            while (currentCid && !found) {
                                const page = await remoteCommunity.posts.getPage({ cid: currentCid });
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
                        const remoteParent = await remotePKC.getComment({ cid: paginatedContext.post!.cid });
                        await remoteParent.update();
                        await waitTillReplyInParentPagesInstance(
                            paginatedContext.reply! as Required<
                                Pick<CommentIpfsWithCidDefined, "parentCid" | "cid"> & { communityAddress: string }
                            >,
                            remoteParent
                        );
                        const replyPageCid = Object.values(remoteParent.replies.pageCids || {})[0];
                        if (!replyPageCid) {
                            const preloadedBest = remoteParent.replies.pages?.best;
                            expect(
                                preloadedBest?.comments.length,
                                "expected preloaded replies to exist when no pageCid is present"
                            ).to.be.greaterThan(0);
                            const replyEntry = preloadedBest?.comments.find((c) => c.cid === paginatedContext.reply!.cid);
                            expect(replyEntry?.author?.address).to.equal(paginatedAliasSigner.address);
                            expect(replyEntry?.signature?.publicKey).to.equal(paginatedAliasSigner.publicKey);
                        } else {
                            const repliesPage = await remoteParent.replies.getPage({ cid: replyPageCid });
                            const replyEntryInPage = repliesPage.comments.find((c) => c.cid === paginatedContext.reply!.cid);
                            expect(replyEntryInPage?.author?.address).to.equal(paginatedAliasSigner.address);
                            expect(replyEntryInPage?.signature?.publicKey).to.equal(paginatedAliasSigner.publicKey);
                        }
                        await remoteParent.stop();
                    });

                    it("Spec: when two posts share the same signer, paginated pages surface distinct anonymized addresses per post with valid signatures", async () => {
                        const remoteCommunity = await remotePKC.getCommunity({ address: paginatedContext.community.address });
                        const seenAddresses = new Map<string, { address: string; publicKey: string }>();

                        for (const firstPageCid of Object.values(remoteCommunity.posts.pageCids)) {
                            let currentCid: string | undefined = firstPageCid;
                            while (currentCid) {
                                const page = await remoteCommunity.posts.getPage({ cid: currentCid });
                                page.comments.forEach((comment) => {
                                    if (comment.cid === paginatedContext.post!.cid) {
                                        seenAddresses.set(comment.cid, {
                                            address: comment.author.address,
                                            publicKey: comment.signature.publicKey
                                        });
                                    }
                                    if (comment.cid === paginatedContext.secondPost!.cid) {
                                        seenAddresses.set(comment.cid, {
                                            address: comment.author.address,
                                            publicKey: comment.signature.publicKey
                                        });
                                    }
                                });
                                if (
                                    page.nextCid &&
                                    (!seenAddresses.has(paginatedContext.post!.cid) || !seenAddresses.has(paginatedContext.secondPost!.cid))
                                )
                                    currentCid = page.nextCid;
                                else break;
                            }
                        }

                        expect(seenAddresses.has(paginatedContext.post!.cid)).to.be.true;
                        expect(seenAddresses.has(paginatedContext.secondPost!.cid)).to.be.true;
                        const firstEntry = seenAddresses.get(paginatedContext.post!.cid)!;
                        const secondEntry = seenAddresses.get(paginatedContext.secondPost!.cid)!;
                        expect(firstEntry.address).to.equal(paginatedAliasSigner.address);
                        expect(firstEntry.publicKey).to.equal(paginatedAliasSigner.publicKey);
                        expect(secondEntry.address).to.equal(secondPostAliasSigner.address);
                        expect(secondEntry.publicKey).to.equal(secondPostAliasSigner.publicKey);
                        expect(firstEntry.address).to.not.equal(secondEntry.address);
                    });
                });
            });
        });
    });

    describe.sequential("mod exclusion from pseudonymization", () => {
        let modContext: PerPostContext;
        let modSigner: SignerWithPublicKeyAddress;
        let regularSigner: SignerWithPublicKeyAddress;

        beforeAll(async () => {
            modContext = await createPerPostCommunity();
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

        it("Spec: mod comment is NOT pseudonymized in per-post mode", async () => {
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

        it("Spec: non-mod is still pseudonymized alongside mod in per-post mode", async () => {
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
            expect(aliasRow.mode).to.equal("per-post");

            await modPost.stop();
            await regularPost.stop();
        });

        it("Spec: mod comment edit uses real key in per-post mode", async () => {
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
        it("Spec: per-post replies stay per-post after switching to per-author", async () => {
            await assertPseudonymityModeTransition({ initialMode: "per-post", nextMode: "per-author" });
        });

        it("Spec: per-post replies stay per-post after switching to per-reply", async () => {
            await assertPseudonymityModeTransition({ initialMode: "per-post", nextMode: "per-reply" });
        });
    });
});

async function expectCommentCidToUseAlias(pkc: PKC, cid: string, aliasSigner: SignerWithPublicKeyAddress) {
    const fetched = JSON.parse((await pkc.fetchCid({ cid })).content) as {
        author?: { address?: string };
        signature?: { publicKey?: string };
        pseudonymityMode?: string;
    };
    expect(fetched?.author?.address).to.be.undefined;
    expect(fetched?.signature?.publicKey).to.equal(aliasSigner.publicKey);
    expect(fetched?.pseudonymityMode).to.equal("per-post");
}

const PROTOCOL_VERSION = "1.0.0";

async function assertPseudonymityModeTransition({ initialMode, nextMode }: { initialMode: string; nextMode: string }) {
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
}) {
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
}) {
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

async function ensureCommunityDbReady(community: LocalCommunity) {
    const localCommunity = community as unknown as LocalCommunityWithPrivateMethods;
    if (typeof localCommunity.initDbHandlerIfNeeded === "function") {
        await localCommunity.initDbHandlerIfNeeded();
    }
    await localCommunity._dbHandler.initDbIfNeeded({ fileMustExist: false });
}

function expectStoredCommentToUseAlias(dbHandler: LocalCommunity["_dbHandler"], cid: string, aliasSigner: SignerWithPublicKeyAddress) {
    const stored = dbHandler.queryComment(cid) as StoredComment;
    expect(stored?.author?.address).to.be.undefined;
    expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
}

async function createAnonymityTransitionContext(initialMode: string): Promise<AnonymityTransitionContext> {
    const pkc = await mockPKC();
    const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
    await community.edit({ features: { pseudonymityMode: initialMode as "per-author" | "per-post" | "per-reply" } });
    await community._dbHandler.initDbIfNeeded({ fileMustExist: false });
    await community._dbHandler.createOrMigrateTablesIfNeeded();
    return {
        community,
        dbHandler: community._dbHandler,
        pkc,
        communityAddress: community.address,
        cleanup: async () => {
            await community.delete();
            await pkc.destroy();
        }
    };
}

async function createPerPostCommunity(): Promise<PerPostContext> {
    const publisherPKC = await mockPKC();
    const community = await createSubWithNoChallenge({}, publisherPKC);
    await community.edit({ features: { pseudonymityMode: "per-post" } });
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
    const timeoutMs = 60000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const stored = community._dbHandler.queryStoredCommentUpdate({ cid }) as StoredCommentUpdate | undefined;
        if (stored) return stored;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for stored comment update for ${cid}`);
}

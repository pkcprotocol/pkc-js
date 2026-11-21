import { beforeAll, afterAll, describe, it, expect } from "vitest";
import Logger from "@pkcprotocol/pkc-logger";
import {
    createAuthorWalletEntry,
    createSubWithNoChallenge,
    disableValidationOfSignatureBeforePublishing,
    ensurePublicationIsSigned,
    mockPKC,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    setExtraPropOnCommentAndSign,
    setExtraPropOnCommentEditAndSign,
    setExtraPropOnCommentModerationAndSign,
    setExtraPropOnVoteAndSign
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { messages } from "../../../dist/node/errors.js";
import { getPKCAddressFromPublicKeySync } from "../../../dist/node/signer/util.js";
import { _signJson, cleanUpBeforePublishing } from "../../../dist/node/signer/signatures.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type Vote from "../../../dist/node/publications/vote/vote.js";
import type { CommentEdit } from "../../../dist/node/publications/comment-edit/comment-edit.js";
import type { CommentModeration } from "../../../dist/node/publications/comment-moderation/comment-moderation.js";
import type { SignerType } from "../../../dist/node/signer/types.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

type WalletEntry = ReturnType<typeof createAuthorWalletEntry>;

const INVALID_PROOF_REASON = `${messages.ERR_AUTHOR_WALLET_PROOF_IS_INVALID}. Chain ticker: eth. signature does not recover the wallet address`;

// An eip191 entry whose signature recovers no wallet address is invalid under BSIP-22
const withBrokenSignature = (entry: WalletEntry): WalletEntry => ({
    ...entry,
    signature: { ...entry.signature, signature: `0x${"00".repeat(64)}1b` }
});

// RPC skipped because these tests craft wire payloads and publish them to a community run in this process
describeSkipIfRpc.sequential("LocalCommunity verifies author.wallets proofs (BSIP-22, issue #566)", () => {
    let pkc: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let targetPost: Comment;
    let moderatorSigner: SignerType;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        targetPost = await publishRandomPost({ communityAddress: community.address, pkc });

        // commentModeration needs a moderator and communityEdit the owner, so give the community both roles
        moderatorSigner = await pkc.createSigner();
        const ownerSigner = community.signer;
        if (!ownerSigner?.address) throw Error("Expected the local community to have an owner signer");
        await community.edit({
            roles: {
                ...(community.roles || {}),
                [moderatorSigner.address]: { role: "moderator" },
                [ownerSigner.address]: { role: "owner" }
            }
        });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () =>
                community.roles?.[moderatorSigner.address]?.role === "moderator" && community.roles?.[ownerSigner.address]?.role === "owner"
        });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    async function newComment() {
        const comment = await pkc.createComment({
            communityAddress: community.address,
            title: `wallet proof ${Date.now()}`,
            content: `wallet proof content ${Date.now()}`,
            signer: await pkc.createSigner()
        });
        await ensurePublicationIsSigned(comment, community);
        return { comment, authorPublicKey: getPKCAddressFromPublicKeySync(comment.signature.publicKey) };
    }

    describe("community acceptance", () => {
        it("accepts a comment whose wallet entry is valid", async () => {
            const { comment, authorPublicKey } = await newComment();
            await setExtraPropOnCommentAndSign(
                comment,
                { author: { wallets: { eth: createAuthorWalletEntry({ authorPublicKey }) } } },
                true
            );
            await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });
        });

        it("accepts a comment whose wallet entry has an unknown signature type", async () => {
            const { comment, authorPublicKey } = await newComment();
            const entry = createAuthorWalletEntry({ authorPublicKey });
            const unknownEntry = { ...entry, signature: { ...entry.signature, type: "ed25519" } };
            await setExtraPropOnCommentAndSign(comment, { author: { wallets: { sol: unknownEntry } } }, true);
            await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });
        });

        it("rejects a comment with an invalid wallet entry and names the chain ticker", async () => {
            const { comment, authorPublicKey } = await newComment();
            const entry = withBrokenSignature(createAuthorWalletEntry({ authorPublicKey }));
            await setExtraPropOnCommentAndSign(comment, { author: { wallets: { eth: entry } } }, true);
            await publishWithExpectedResult({
                publication: comment,
                expectedChallengeSuccess: false,
                expectedReason: INVALID_PROOF_REASON
            });
        });

        it("rejects a comment that carries a proof made for another author key", async () => {
            const { comment } = await newComment();
            const otherSigner = await pkc.createSigner();
            const entry = createAuthorWalletEntry({ authorPublicKey: otherSigner.address });
            await setExtraPropOnCommentAndSign(comment, { author: { wallets: { eth: entry } } }, true);
            await publishWithExpectedResult({
                publication: comment,
                expectedChallengeSuccess: false,
                expectedReason: INVALID_PROOF_REASON
            });
        });

        // The request schema (WalletSchema) already requires signature and type, so an entry without them is rejected
        // at parse time, before the BSIP-22 check runs.
        it("rejects a comment whose wallet entry has no signature.type", async () => {
            const { comment, authorPublicKey } = await newComment();
            const entry = createAuthorWalletEntry({ authorPublicKey });
            const typeless = { address: entry.address, timestamp: entry.timestamp, signature: { signature: entry.signature.signature } };
            await setExtraPropOnCommentAndSign(comment, { author: { wallets: { eth: typeless } } }, true);
            await publishWithExpectedResult({
                publication: comment,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_REQUEST_ENCRYPTED_HAS_INVALID_SCHEMA_AFTER_DECRYPTING
            });
        });

        it("rejects a vote with an invalid wallet entry", async () => {
            if (!targetPost.cid) throw Error("Expected target post to have a CID");
            const vote = await pkc.createVote({
                commentCid: targetPost.cid,
                vote: 1,
                communityAddress: community.address,
                signer: await pkc.createSigner()
            });
            await ensurePublicationIsSigned(vote, community);
            const authorPublicKey = getPKCAddressFromPublicKeySync(vote.signature.publicKey);
            const entry = withBrokenSignature(createAuthorWalletEntry({ authorPublicKey }));
            await setExtraPropOnVoteAndSign(vote as Vote, { author: { wallets: { eth: entry } } }, true);
            await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: false, expectedReason: INVALID_PROOF_REASON });
        });

        it("rejects a commentEdit with an invalid wallet entry", async () => {
            if (!targetPost.cid || !targetPost.signer) throw Error("Expected target post with a CID and a signer");
            const commentEdit = await pkc.createCommentEdit({
                commentCid: targetPost.cid,
                content: `wallet proof edit ${Date.now()}`,
                communityAddress: community.address,
                signer: targetPost.signer
            });
            await ensurePublicationIsSigned(commentEdit, community);
            const authorPublicKey = getPKCAddressFromPublicKeySync(commentEdit.signature.publicKey);
            const entry = withBrokenSignature(createAuthorWalletEntry({ authorPublicKey }));
            await setExtraPropOnCommentEditAndSign(commentEdit as CommentEdit, { author: { wallets: { eth: entry } } }, true);
            await publishWithExpectedResult({
                publication: commentEdit,
                expectedChallengeSuccess: false,
                expectedReason: INVALID_PROOF_REASON
            });
        });

        it("rejects a commentModeration with an invalid wallet entry", async () => {
            if (!targetPost.cid) throw Error("Expected target post to have a CID");
            const commentModeration = await pkc.createCommentModeration({
                communityAddress: community.address,
                commentCid: targetPost.cid,
                commentModeration: { reason: `wallet proof moderation ${Date.now()}`, spoiler: true },
                signer: moderatorSigner
            });
            await ensurePublicationIsSigned(commentModeration, community);
            const entry = withBrokenSignature(createAuthorWalletEntry({ authorPublicKey: moderatorSigner.address }));
            await setExtraPropOnCommentModerationAndSign(
                commentModeration as CommentModeration,
                { author: { wallets: { eth: entry } } },
                true
            );
            await publishWithExpectedResult({
                publication: commentModeration,
                expectedChallengeSuccess: false,
                expectedReason: INVALID_PROOF_REASON
            });
        });

        it("rejects a communityEdit with an invalid wallet entry", async () => {
            const ownerSigner = community.signer as SignerType;
            if (!ownerSigner?.address) throw Error("Expected the local community to expose its owner signer");
            const communityEdit = await pkc.createCommunityEdit({
                communityAddress: community.address,
                communityEdit: { description: `wallet proof community edit ${Date.now()}` },
                signer: ownerSigner
            });
            await ensurePublicationIsSigned(communityEdit, community);
            const entry = withBrokenSignature(createAuthorWalletEntry({ authorPublicKey: ownerSigner.address }));
            // No setExtraPropOn helper exists for a communityEdit: add the wallets to the signed record and sign it again,
            // with author among the signed property names so the entry is covered by the signature
            const signed = communityEdit.raw.pubsubMessageToPublish!;
            const withWallets = { ...signed, author: { ...(signed.author || {}), wallets: { eth: entry } } };
            const signedPropertyNames = signed.signature.signedPropertyNames.includes("author")
                ? signed.signature.signedPropertyNames
                : [...signed.signature.signedPropertyNames, "author"];
            withWallets.signature = await _signJson(
                signedPropertyNames,
                cleanUpBeforePublishing(withWallets),
                communityEdit.signer!,
                Logger("pkc-js:test:author-wallet-proof:communityEdit")
            );
            communityEdit.raw.pubsubMessageToPublish = withWallets;
            communityEdit.signature = withWallets.signature;
            disableValidationOfSignatureBeforePublishing(communityEdit);
            await publishWithExpectedResult({
                publication: communityEdit,
                expectedChallengeSuccess: false,
                expectedReason: INVALID_PROOF_REASON
            });
        });
    });

    describe("local pre-publish check", () => {
        async function commentWithWallet(entry: WalletEntry, signer: Awaited<ReturnType<typeof pkc.createSigner>>) {
            return pkc.createComment({
                communityAddress: community.address,
                title: `local check ${Date.now()}`,
                content: "local check content",
                author: { wallets: { eth: entry } },
                signer
            });
        }

        it("publish() throws ERR_AUTHOR_WALLET_PROOF_IS_INVALID naming the ticker, sends nothing and leaves the instance stopped", async () => {
            const signer = await pkc.createSigner();
            const comment = await commentWithWallet(
                withBrokenSignature(createAuthorWalletEntry({ authorPublicKey: signer.address })),
                signer
            );
            await expect(comment.publish()).rejects.toMatchObject({
                code: "ERR_AUTHOR_WALLET_PROOF_IS_INVALID",
                details: expect.objectContaining({ chainTicker: "eth" })
            });
            expect(comment.state).to.equal("stopped");
        });

        it("checks the signed record, not the runtime author fields", async () => {
            const { comment, authorPublicKey } = await newComment();
            const entry = withBrokenSignature(createAuthorWalletEntry({ authorPublicKey }));
            await setExtraPropOnCommentAndSign(comment, { author: { wallets: { eth: entry } } }, true);
            // setExtraPropOnCommentAndSign turns the local check off to craft wire payloads; clear that instance
            // override so the prototype method runs
            delete (comment as unknown as Record<string, unknown>)._validateAuthorWalletProofs;
            comment.author.wallets = {}; // the runtime field now says no wallets, the signed record still carries the bad entry
            await expect(comment.publish()).rejects.toMatchObject({ code: "ERR_AUTHOR_WALLET_PROOF_IS_INVALID" });
        });

        it("publish() accepts a valid wallet entry", async () => {
            const signer = await pkc.createSigner();
            const comment = await commentWithWallet(createAuthorWalletEntry({ authorPublicKey: signer.address }), signer);
            await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });
        });
    });
});

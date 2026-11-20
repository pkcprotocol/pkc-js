import { beforeAll, afterAll, afterEach, describe, it, expect } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import {
    createSubWithNoChallenge,
    disableValidationOfSignatureBeforePublishing,
    ensurePublicationIsSigned,
    mockPKC,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    setExtraPropOnCommentAndSign,
    setExtraPropOnCommentEditAndSign,
    setExtraPropOnVoteAndSign
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { messages } from "../../../dist/node/errors.js";
import { authorWalletProofEnforcement } from "../../../dist/node/runtime/node/community/local-community/publication-validation.js";
import { getAuthorWalletProofMessage, verifyAuthorWalletEntry } from "../../../dist/node/signer/author-wallet-proof.js";
import { getPKCAddressFromPublicKeySync } from "../../../dist/node/signer/util.js";
import { timestamp } from "../../../dist/node/util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type Vote from "../../../dist/node/publications/vote/vote.js";
import type { CommentEdit } from "../../../dist/node/publications/comment-edit/comment-edit.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

const WALLET_PRIVATE_KEY_HEX = "02".repeat(32);

// What a wallet does for personal_sign: EIP-191 digest, low-s ECDSA, v of 27 or 28.
function signWalletEntry({ authorPublicKey, entryTimestamp }: { authorPublicKey: string; entryTimestamp: number }) {
    const walletPublicKey = secp256k1.getPublicKey(hexToBytes(WALLET_PRIVATE_KEY_HEX), false);
    const address = `0x${bytesToHex(keccak_256(walletPublicKey.slice(1)).slice(12))}`;
    const message = getAuthorWalletProofMessage({ authorPublicKey, walletAddress: address, timestamp: entryTimestamp });
    const messageBytes = utf8ToBytes(message);
    const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
    const digest = keccak_256(new Uint8Array([...prefix, ...messageBytes]));
    const compact = secp256k1.sign(digest, hexToBytes(WALLET_PRIVATE_KEY_HEX), { prehash: false });
    for (const v of [27, 28]) {
        const entry = {
            address,
            timestamp: entryTimestamp,
            signature: { signature: `0x${bytesToHex(compact)}${v.toString(16)}`, type: "eip191" }
        };
        if (verifyAuthorWalletEntry({ entry, authorPublicKey, nowSeconds: entryTimestamp }).outcome === "valid") return entry;
    }
    throw Error("Failed to produce a valid wallet entry for the test");
}

// RPC skipped because enforcement is a module-level switch of the community's process, and the RPC server is a different process
describeSkipIfRpc.sequential("LocalCommunity verifies author.wallets proofs (BSIP-22, issue #566)", () => {
    let pkc: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let targetPost: Comment;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        targetPost = await publishRandomPost({ communityAddress: community.address, pkc });
    });

    afterEach(() => {
        authorWalletProofEnforcement.enabled = false;
    });

    afterAll(async () => {
        authorWalletProofEnforcement.enabled = false;
        await community.delete();
        await pkc.destroy();
    });

    async function newComment() {
        const signer = await pkc.createSigner();
        const comment = await pkc.createComment({
            communityAddress: community.address,
            title: `wallet proof ${Date.now()}`,
            content: `wallet proof content ${Date.now()}`,
            signer
        });
        await ensurePublicationIsSigned(comment, community);
        return { comment, authorPublicKey: getPKCAddressFromPublicKeySync(comment.signature.publicKey) };
    }

    const invalidEntry = (entry: ReturnType<typeof signWalletEntry>) => ({
        ...entry,
        // an eip191 signature made for another author key never verifies
        signature: { ...entry.signature, signature: `0x${"00".repeat(64)}1b` }
    });

    it("enforcement is off by default: a comment with an invalid wallet entry is accepted", async () => {
        expect(authorWalletProofEnforcement.enabled).to.equal(false);
        const { comment, authorPublicKey } = await newComment();
        const entry = invalidEntry(signWalletEntry({ authorPublicKey, entryTimestamp: timestamp() }));
        await setExtraPropOnCommentAndSign(comment, { author: { wallets: { eth: entry } } }, true);
        await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });
    });

    describe("with enforcement on", () => {
        beforeAll(() => {
            authorWalletProofEnforcement.enabled = true;
        });
        afterAll(() => {
            authorWalletProofEnforcement.enabled = false;
        });
        // afterEach above resets the flag, so each test turns it back on
        const enforce = () => {
            authorWalletProofEnforcement.enabled = true;
        };

        it("accepts a comment whose wallet entry is valid", async () => {
            enforce();
            const { comment, authorPublicKey } = await newComment();
            const entry = signWalletEntry({ authorPublicKey, entryTimestamp: timestamp() });
            await setExtraPropOnCommentAndSign(comment, { author: { wallets: { eth: entry } } }, true);
            await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });
        });

        it("accepts a comment whose wallet entry has an unknown signature type", async () => {
            enforce();
            const { comment, authorPublicKey } = await newComment();
            const entry = signWalletEntry({ authorPublicKey, entryTimestamp: timestamp() });
            const unknownEntry = { ...entry, signature: { ...entry.signature, type: "ed25519" } };
            await setExtraPropOnCommentAndSign(comment, { author: { wallets: { sol: unknownEntry } } }, true);
            await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });
        });

        it("rejects a comment with an invalid wallet entry and names the chain ticker", async () => {
            enforce();
            const { comment, authorPublicKey } = await newComment();
            const entry = invalidEntry(signWalletEntry({ authorPublicKey, entryTimestamp: timestamp() }));
            await setExtraPropOnCommentAndSign(comment, { author: { wallets: { eth: entry } } }, true);
            await publishWithExpectedResult({
                publication: comment,
                expectedChallengeSuccess: false,
                expectedReason: `${messages.ERR_AUTHOR_WALLET_PROOF_IS_INVALID}. Chain ticker: eth. signature does not recover the wallet address`
            });
        });

        it("rejects a comment that carries a proof made for another author key", async () => {
            enforce();
            const { comment } = await newComment();
            const otherSigner = await pkc.createSigner();
            const entry = signWalletEntry({ authorPublicKey: otherSigner.address, entryTimestamp: timestamp() });
            await setExtraPropOnCommentAndSign(comment, { author: { wallets: { eth: entry } } }, true);
            await publishWithExpectedResult({
                publication: comment,
                expectedChallengeSuccess: false,
                expectedReason: `${messages.ERR_AUTHOR_WALLET_PROOF_IS_INVALID}. Chain ticker: eth. signature does not recover the wallet address`
            });
        });

        // The request schema (WalletSchema) already requires signature and type, so an entry without them is rejected
        // at parse time, before the BSIP-22 check runs, and with or without the enforcement switch.
        it("rejects a comment whose wallet entry has no signature.type", async () => {
            enforce();
            const { comment, authorPublicKey } = await newComment();
            const entry = signWalletEntry({ authorPublicKey, entryTimestamp: timestamp() });
            const typeless = { address: entry.address, timestamp: entry.timestamp, signature: { signature: entry.signature.signature } };
            await setExtraPropOnCommentAndSign(comment, { author: { wallets: { eth: typeless } } }, true);
            await publishWithExpectedResult({
                publication: comment,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_REQUEST_ENCRYPTED_HAS_INVALID_SCHEMA_AFTER_DECRYPTING
            });
        });

        it("rejects a vote with an invalid wallet entry", async () => {
            enforce();
            if (!targetPost.cid) throw Error("Expected target post to have a CID");
            const vote = await pkc.createVote({
                commentCid: targetPost.cid,
                vote: 1,
                communityAddress: community.address,
                signer: await pkc.createSigner()
            });
            await ensurePublicationIsSigned(vote, community);
            const authorPublicKey = getPKCAddressFromPublicKeySync(vote.signature.publicKey);
            const entry = invalidEntry(signWalletEntry({ authorPublicKey, entryTimestamp: timestamp() }));
            await setExtraPropOnVoteAndSign(vote as Vote, { author: { wallets: { eth: entry } } }, true);
            await publishWithExpectedResult({
                publication: vote,
                expectedChallengeSuccess: false,
                expectedReason: `${messages.ERR_AUTHOR_WALLET_PROOF_IS_INVALID}. Chain ticker: eth. signature does not recover the wallet address`
            });
        });

        it("rejects a commentEdit with an invalid wallet entry", async () => {
            enforce();
            if (!targetPost.cid || !targetPost.signer) throw Error("Expected target post with a CID and a signer");
            const commentEdit = await pkc.createCommentEdit({
                commentCid: targetPost.cid,
                content: `wallet proof edit ${Date.now()}`,
                communityAddress: community.address,
                signer: targetPost.signer
            });
            await ensurePublicationIsSigned(commentEdit, community);
            const authorPublicKey = getPKCAddressFromPublicKeySync(commentEdit.signature.publicKey);
            const entry = invalidEntry(signWalletEntry({ authorPublicKey, entryTimestamp: timestamp() }));
            await setExtraPropOnCommentEditAndSign(commentEdit as CommentEdit, { author: { wallets: { eth: entry } } }, true);
            await publishWithExpectedResult({
                publication: commentEdit,
                expectedChallengeSuccess: false,
                expectedReason: `${messages.ERR_AUTHOR_WALLET_PROOF_IS_INVALID}. Chain ticker: eth. signature does not recover the wallet address`
            });
        });
    });

    describe("local pre-publish check", () => {
        it("publish() throws ERR_AUTHOR_WALLET_PROOF_IS_INVALID naming the ticker, before anything is sent", async () => {
            const signer = await pkc.createSigner();
            const entry = invalidEntry(signWalletEntry({ authorPublicKey: signer.address, entryTimestamp: timestamp() }));
            const comment = await pkc.createComment({
                communityAddress: community.address,
                title: `local check ${Date.now()}`,
                content: "local check content",
                author: { wallets: { eth: entry } },
                signer
            });
            await expect(comment.publish()).rejects.toMatchObject({
                code: "ERR_AUTHOR_WALLET_PROOF_IS_INVALID",
                details: expect.objectContaining({ chainTicker: "eth" })
            });
        });

        it("publish() accepts a valid wallet entry", async () => {
            const signer = await pkc.createSigner();
            const entry = signWalletEntry({ authorPublicKey: signer.address, entryTimestamp: timestamp() });
            const comment = await pkc.createComment({
                communityAddress: community.address,
                title: `local check valid ${Date.now()}`,
                content: "local check valid content",
                author: { wallets: { eth: entry } },
                signer
            });
            await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });
        });
    });
});

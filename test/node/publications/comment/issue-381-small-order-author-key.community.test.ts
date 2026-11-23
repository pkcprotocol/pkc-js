import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import {
    createSubWithNoChallenge,
    generateMockPost,
    publishWithExpectedResult,
    disableValidationOfSignatureBeforePublishing,
    mockPKC
} from "../../../../dist/node/test/test-util.js";
import { verifyBufferEd25519, signBufferEd25519 } from "../../../../dist/node/signer/signatures.js";
import { getPKCAddressFromPublicKey, getPublicKeyFromPrivateKey } from "../../../../dist/node/signer/util.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";

// Spin-off from #381: an ed25519 "small-order" public key (the identity point, bytes 01 00..00, and
// the seven other low-order points) is a shared, private-key-less identity. Under ZIP-215, which
// noble applies by default, the forged signature R=identity, S=0 verifies for ANY message under
// such a key. Every pkc-js publication (comment, vote, comment-edit, moderation, community, ...)
// verifies its author signature through verifyBufferEd25519, and a LocalCommunity derives the
// author only from signature.publicKey, so before the fix it accepted a record nobody holds a
// private key for. The fix rejects small-order keys in verifyBufferEd25519, the one shared gate.
// Issue #596.
// Must live under test/node because it drives a LocalCommunity directly.

// The identity point: a 32-byte public key 01 00..00 and the 64-byte signature R=identity, S=0.
const identityPublicKeyBuf = new Uint8Array(32);
identityPublicKeyBuf[0] = 1;
const identitySignatureBuf = new Uint8Array(64);
identitySignatureBuf[0] = 1;
const identityPublicKey = uint8ArrayToString(identityPublicKeyBuf, "base64");
const identitySignature = uint8ArrayToString(identitySignatureBuf, "base64");

describe("issue #381 spin-off: small-order ed25519 public keys are rejected", () => {
    // Unit guard on the shared verification gate. Every publication type routes its author-signature
    // check through verifyBufferEd25519, so a reject here covers all of them.
    it("verifyBufferEd25519 rejects the identity-point key with the forged signature, over any message", async () => {
        for (const message of ["any message", "a different message", ""]) {
            const valid = await verifyBufferEd25519(new TextEncoder().encode(message), identitySignatureBuf, identityPublicKey);
            expect(valid, `message ${JSON.stringify(message)}`).to.equal(false);
        }
    });

    it("verifyBufferEd25519 still accepts a genuine signature from a full-order key (fix is not over-broad)", async () => {
        const privateKey = uint8ArrayToString(crypto.getRandomValues(new Uint8Array(32)), "base64");
        const publicKey = await getPublicKeyFromPrivateKey(privateKey);
        const buffer = new TextEncoder().encode("a genuine message");
        const signature = await signBufferEd25519(buffer, privateKey);
        expect(await verifyBufferEd25519(buffer, signature, publicKey)).to.equal(true);
    });

    describe("a LocalCommunity rejects a comment signed by the identity-point key", () => {
        let pkc: PKC;
        let community: LocalCommunity;

        beforeAll(async () => {
            pkc = await mockPKC();
            community = (await createSubWithNoChallenge({ title: "small-order-key repro" }, pkc)) as LocalCommunity;
            await community.start();
            await new Promise<void>((resolve) => {
                if (community.updatingState === "succeeded" || community.startedState === "succeeded") return resolve();
                community.once("update", () => resolve());
            });
        });

        afterAll(async () => {
            await community?.delete();
            await pkc?.destroy();
        });

        it("the forged comment is rejected as an invalid signature", async () => {
            const forgedAddress = await getPKCAddressFromPublicKey(identityPublicKey);
            const post = await generateMockPost({ communityAddress: community.address, pkc });

            // Forge the record in place just before it is encrypted and sent. The returned request's
            // `.comment` IS post.raw.pubsubMessageToPublish, so this also forges the stored copy.
            // author carries no `address` on the wire (it is reserved there); the community derives
            // the author's address from signature.publicKey, i.e. from the forged identity key.
            const originalToJSON = post.toJSONPubsubRequestToEncrypt.bind(post);
            (post as any).toJSONPubsubRequestToEncrypt = () => {
                const request = originalToJSON();
                const forgedComment = request.comment as any;
                forgedComment.signature = {
                    type: "ed25519",
                    publicKey: identityPublicKey,
                    signature: identitySignature,
                    signedPropertyNames: forgedComment.signature.signedPropertyNames
                };
                return request;
            };
            // The client would otherwise reject its own forged record before sending.
            await disableValidationOfSignatureBeforePublishing(post);

            await publishWithExpectedResult({
                publication: post,
                expectedChallengeSuccess: false,
                expectedReason: "Signature of publication is invalid"
            });
            expect(post.cid, "community must not mint a cid for a forged comment").to.be.undefined;
            expect(forgedAddress).to.be.a("string"); // the forged key does derive a normal-looking address
        });
    });
});

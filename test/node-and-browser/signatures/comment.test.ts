import { beforeAll, afterAll } from "vitest";
import { mockRemotePKC, describeSkipIfRpc, resolveWhenConditionIsTrue, createMockNameResolver } from "../../../dist/node/test/test-util.js";
import {
    signComment,
    verifyCommentUpdate,
    signCommentUpdate,
    signCommentEdit,
    verifyCommentPubsubMessage,
    verifyCommentIpfs
} from "../../../dist/node/signer/signatures.js";
import { messages } from "../../../dist/node/errors.js";
import signers from "../../fixtures/signers.js";
import { timestamp } from "../../../dist/node/util.js";
import * as remeda from "remeda";
import validCommentFixture from "../../fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json" with { type: "json" };
import validCommentAvatarFixture from "../../fixtures/signatures/comment/valid_comment_avatar_fixture.json" with { type: "json" };
import validCommentAuthorAddressDomainFixture from "../../fixtures/signatures/comment/valid_comment_author_address_as_domain.json" with { type: "json" };
import validCommentUpdateFixture from "../../fixtures/signatures/comment/commentUpdate/valid_comment_update.json" with { type: "json" };
import validCommentUpdateWithAuthorEditFixture from "../../fixtures/signatures/comment/commentUpdate_authorEdit/valid_comment_update.json" with { type: "json" };
import validCommentWithAuthorEditFixture from "../../fixtures/signatures/comment/commentUpdate_authorEdit/valid_comment_ipfs.json" with { type: "json" };
import { comment as fixtureComment } from "../../fixtures/publications.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type {
    CommentOptionsToSign,
    CommentPubsubMessagePublication,
    CommentIpfsType,
    CommentIpfsWithCidPostCidDefined,
    CommentUpdateType
} from "../../../dist/node/publications/comment/types.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

// Protocol version constant
const PROTOCOL_VERSION = "1.0.0";

type LegacyCommentPublication = CommentPubsubMessagePublication & {
    author: {
        address?: string;
        name?: string;
    };
};

const fixtureSignature = {
    signature: "RTBNJ8bEnvEENOAxzk3pqxc9I3a0M9H7qlXsL5yu2frEEbJKqf789eFVnmyccmB99hyBb1Hyw5Soqma+RIxIAw",
    publicKey: "CFhuD55tmzZjWZ113tZbDw/AsuNDkgSdvCCbPeqiF10",
    type: "ed25519",
    signedPropertyNames: Object.keys(fixtureComment).sort()
};

// Helper to create a comment with all required fields for signing
function createCommentToSign(opts: {
    communityAddress: string;
    author?: CommentOptionsToSign["author"];
    signer: (typeof signers)[0];
    title?: string;
    content?: string;
}): CommentOptionsToSign {
    return {
        communityAddress: opts.communityAddress,
        ...(opts.author === undefined ? undefined : { author: opts.author }),
        timestamp: timestamp(),
        protocolVersion: PROTOCOL_VERSION,
        title: opts.title ?? "Test post signature",
        content: opts.content ?? "some content...",
        signer: opts.signer
    };
}

describe("sign comment", async () => {
    let pkc: PKCType;
    let signedCommentClone: CommentPubsubMessagePublication;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it("Can sign a comment with randomly generated key", async () => {
        const signer = await pkc.createSigner();

        const comment = createCommentToSign({
            communityAddress: signers[0].address,
            signer
        });
        const signature = await signComment({ comment, pkc: pkc });
        expect(signature.publicKey).to.equal(signer.publicKey);
        const signedComment: CommentPubsubMessagePublication = { signature, ...remeda.omit(comment, ["signer", "communityAddress"]) };
        const verificaiton = await verifyCommentPubsubMessage({
            comment: signedComment,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(verificaiton).to.deep.equal({ valid: true });
        signedCommentClone = remeda.clone(signedComment);
    });

    it("Can sign a comment with an imported key", async () => {
        const signer = await pkc.createSigner({ privateKey: signers[1].privateKey, type: "ed25519" });
        const comment = createCommentToSign({
            communityAddress: signers[0].address,
            signer
        });
        const signature = await signComment({ comment, pkc: pkc });
        const signedComment: CommentPubsubMessagePublication = { signature, ...remeda.omit(comment, ["signer", "communityAddress"]) };
        expect(signedComment.signature.publicKey).to.be.equal(signers[1].publicKey, "Generated public key should be same as provided");
        const verificaiton = await verifyCommentPubsubMessage({
            comment: signedComment,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(verificaiton).to.deep.equal({ valid: true });
    });

    it("signComment author signature is correct and deterministic", async () => {
        // Note: fixtureComment doesn't have protocolVersion, and communityAddress is now
        // omitted from signedPropertyNames. We verify determinism (signing twice produces same result)
        const commentToSign = { ...fixtureComment, signer: signers[1] } as unknown as CommentOptionsToSign;
        const authorSignature = await signComment({ comment: commentToSign, pkc: pkc });
        expect(authorSignature).to.exist;
        expect(authorSignature.publicKey).to.equal(signers[1].publicKey);
        expect(authorSignature.type).to.equal("ed25519");
        // communityAddress should NOT be in signedPropertyNames
        expect(authorSignature.signedPropertyNames).to.not.include("communityAddress");
        // Verify determinism: signing same input again produces same signature
        const authorSignature2 = await signComment({ comment: commentToSign, pkc: pkc });
        expect(authorSignature2.signature).to.equal(authorSignature.signature);
        expect(authorSignature2.signedPropertyNames.sort()).to.deep.equal(authorSignature.signedPropertyNames.sort());
    });

    it(`signComment throws with author.name not being a domain`, async () => {
        const cloneComment = remeda.clone(signedCommentClone) as CommentPubsubMessagePublication;
        delete (cloneComment as { signature?: unknown }).signature;
        cloneComment.author = { name: "gibbreish" };
        try {
            const commentToSign: CommentOptionsToSign = {
                ...cloneComment,
                protocolVersion: PROTOCOL_VERSION,
                signer: signers[7],
                communityAddress: signers[7].address
            };
            await signComment({ comment: commentToSign, pkc: pkc });
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_AUTHOR_ADDRESS_IS_NOT_A_DOMAIN_OR_B58");
        }
    });
    it("can sign a comment without author", async () => {
        const signer = signers[7];
        const comment = createCommentToSign({
            communityAddress: signer.address,
            signer,
            title: "comment title",
            content: "comment content"
        });
        const signature = await signComment({ comment, pkc: pkc });
        const signedComment: CommentPubsubMessagePublication = { signature, ...remeda.omit(comment, ["signer", "communityAddress"]) };
        const res = await verifyCommentPubsubMessage({
            comment: signedComment,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(res).to.deep.equal({ valid: true });
    });
    it("can sign a comment with author.name as domain", async () => {
        const signer = signers[4];

        const comment = createCommentToSign({
            communityAddress: signer.address,
            author: { name: "plebbit.eth" },
            signer,
            title: "comment title",
            content: "comment content"
        });
        const signature = await signComment({ comment, pkc: pkc });
        const signedComment: CommentPubsubMessagePublication = { signature, ...remeda.omit(comment, ["signer", "communityAddress"]) };
        const res = await verifyCommentPubsubMessage({
            comment: signedComment,
            resolveAuthorNames: false,
            clientsManager: pkc._clientsManager
        });
        expect(res).to.deep.equal({ valid: true });
    });
    it("can sign a comment with author.displayName = undefined", async () => {
        const signer = signers[4];

        const comment = createCommentToSign({
            communityAddress: signer.address,
            signer,
            title: "comment title",
            content: "comment content"
        });
        // Override timestamp for deterministic test
        (comment as { timestamp: number }).timestamp = 12345678;
        const signature = await signComment({ comment, pkc: pkc });
        const signedComment: CommentPubsubMessagePublication = { signature, ...remeda.omit(comment, ["signer", "communityAddress"]) };
        const res = await verifyCommentPubsubMessage({
            comment: signedComment,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(res).to.deep.equal({ valid: true });
    });
});

// Clients of RPC will trust the response of RPC and won't validate
describeSkipIfRpc("verify Comment", async () => {
    let pkc: PKCType;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Valid signature fixture is validated correctly`, async () => {
        // Sign the fixture comment with the current signing logic and verify
        const commentToSign = { ...fixtureComment, signer: signers[1] } as unknown as CommentOptionsToSign;
        const freshSignature = await signComment({ comment: commentToSign, pkc: pkc });
        const fixtureWithSignature = {
            ...remeda.omit(commentToSign, ["signer", "communityAddress"]),
            signature: freshSignature
        } as unknown as CommentPubsubMessagePublication;
        const verification = await verifyCommentPubsubMessage({
            comment: fixtureWithSignature,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it("verifyCommentPubsubMessage failure with wrong signature", async () => {
        const invalidSignature = remeda.clone(fixtureSignature);
        invalidSignature.signature += "1";

        // Note: fixtureComment doesn't have protocolVersion
        const wronglySignedPublication = { ...fixtureComment, signature: invalidSignature } as unknown as CommentPubsubMessagePublication;
        const verification = await verifyCommentPubsubMessage({
            comment: wronglySignedPublication,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
    });

    it(`Valid Comment fixture from previous pkc-js version is validated correctly`, async () => {
        const comment = remeda.clone(validCommentFixture) as CommentIpfsType;

        const verification = await verifyCommentIpfs({
            comment,
            clientsManager: pkc._clientsManager,
            resolveAuthorNames: false,
            calculatedCommentCid: "QmTest"
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it(`A comment with avatar fixture is validated correctly`, async () => {
        const comment = remeda.clone(validCommentAvatarFixture) as CommentIpfsType;
        const verification = await verifyCommentIpfs({
            comment,
            clientsManager: pkc._clientsManager,
            resolveAuthorNames: true,
            calculatedCommentCid: "QmTest"
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it(`verifyCommentPubsubMessage invalidates a comment with tampered author.name`, async () => {
        const comment = remeda.clone({ ...fixtureComment, signature: fixtureSignature }) as unknown as LegacyCommentPublication;
        comment.author.name = "gibbresish";
        const verification = await verifyCommentPubsubMessage({
            comment: comment as unknown as CommentPubsubMessagePublication,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        // Modifying author.name without re-signing invalidates the signature
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
    });
    it("verifyCommentPubsubMessage validates a comment without author", async () => {
        const signer = await pkc.createSigner();
        const commentToSign = createCommentToSign({
            communityAddress: signers[0].address,
            signer,
            title: "Authorless verification",
            content: "some content"
        });
        const comment: CommentPubsubMessagePublication = {
            ...remeda.omit(commentToSign, ["signer", "communityAddress"]),
            signature: await signComment({ comment: commentToSign, pkc: pkc })
        };
        const verification = await verifyCommentPubsubMessage({
            comment,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it(`Can sign and verify a comment with flairs`, async () => {
        const signer = await pkc.createSigner();
        const commentToSign: CommentOptionsToSign = {
            communityAddress: signers[0].address,
            timestamp: timestamp(),
            protocolVersion: PROTOCOL_VERSION,
            title: "Post with flairs",
            content: "Testing flairs",
            flairs: [{ text: "Discussion" }, { text: "Verified", backgroundColor: "#00ff00" }],
            signer
        };
        const signature = await signComment({ comment: commentToSign, pkc: pkc });
        const signedComment: CommentPubsubMessagePublication = { signature, ...remeda.omit(commentToSign, ["signer", "communityAddress"]) };
        const verification = await verifyCommentPubsubMessage({
            comment: signedComment,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(verification).to.deep.equal({ valid: true });
        expect(signedComment.signature.signedPropertyNames).to.include("flairs");
    });

    it(`Can verify a comment whose author.flairs have been changed`, async () => {
        const signer = await pkc.createSigner();
        const commentToSign: CommentOptionsToSign = {
            communityAddress: signers[0].address,
            author: { flairs: [{ text: "Original" }] },
            timestamp: timestamp(),
            protocolVersion: PROTOCOL_VERSION,
            title: "Post with author flairs",
            content: "Testing author flairs",
            signer
        };
        const signature = await signComment({ comment: commentToSign, pkc: pkc });
        const signedComment: CommentPubsubMessagePublication = { signature, ...remeda.omit(commentToSign, ["signer", "communityAddress"]) };

        // Tamper with author.flairs
        signedComment.author.flairs = [{ text: "Tampered" }];
        const verification = await verifyCommentPubsubMessage({
            comment: signedComment,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
    });

    it(`can verify a comment whose flairs have been changed by mod`, async () => {
        // Signing a comment with flairs, then modifying the flairs should invalidate the signature
        const signer = await pkc.createSigner();
        const commentToSign: CommentOptionsToSign = {
            communityAddress: signers[0].address,
            timestamp: timestamp(),
            protocolVersion: PROTOCOL_VERSION,
            title: "Post to be mod-flaired",
            content: "Testing mod flairs tampering",
            flairs: [{ text: "Original" }],
            signer
        };
        const signature = await signComment({ comment: commentToSign, pkc: pkc });
        const signedComment: CommentPubsubMessagePublication = { signature, ...remeda.omit(commentToSign, ["signer", "communityAddress"]) };

        // Tamper with flairs as if a mod changed them
        signedComment.flairs = [{ text: "Mod Changed" }];
        const verification = await verifyCommentPubsubMessage({
            comment: signedComment,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
    });

    it(`verifyCommentIpfs rejects a tampered signature even after the same CID was previously verified as valid`, async () => {
        const validComment = remeda.clone(validCommentFixture) as CommentIpfsType;
        const calculatedCommentCid = "QmCacheBugTest";

        // First call: valid signature, populates the cache
        const validVerification = await verifyCommentIpfs({
            comment: validComment,
            clientsManager: pkc._clientsManager,
            resolveAuthorNames: false,
            calculatedCommentCid
        });
        expect(validVerification).to.deep.equal({ valid: true });

        // Second call: same CID but tampered signature — must NOT return cached { valid: true }
        const tamperedComment = remeda.clone(validCommentFixture) as CommentIpfsType;
        tamperedComment.signature.signature += "invalid";
        const tamperedVerification = await verifyCommentIpfs({
            comment: tamperedComment,
            clientsManager: pkc._clientsManager,
            resolveAuthorNames: false,
            calculatedCommentCid
        });
        expect(tamperedVerification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
    });

    it(`verifyCommentIpfs passes when communityPublicKey differs from sub but communityName matches (key rotation)`, async () => {
        const comment = remeda.clone(validCommentFixture) as CommentIpfsType;
        // Simulate key rotation: comment was published under old key, sub now has new key.
        // Add new-format fields; old communityAddress stays for signature validity since it's in signedPropertyNames.
        // getCommunityAddressFromRecord returns communityName first, so the address check uses the domain, not the key.
        (comment as Record<string, unknown>).communityName = "example.eth";
        (comment as Record<string, unknown>).communityPublicKey = signers[6].address; // "old" key, differs from sub's current

        const verification = await verifyCommentIpfs({
            comment,
            clientsManager: pkc._clientsManager,
            resolveAuthorNames: false,
            calculatedCommentCid: "QmKeyRotationTest",
            communityAddressFromInstance: "example.eth" // matches communityName
        });
        expect(verification).to.deep.equal({ valid: true });
    });
});

// Clients of RPC will trust the response of RPC and won't validate
describeSkipIfRpc(`Comment with author.name as domain`, async () => {
    it(`verifyCommentPubsubMessage returns valid when author.name resolves to a different author (domain mismatch is not a signature failure)`, async () => {
        const tempPKC = await mockRemotePKC({
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [
                    createMockNameResolver({
                        records: new Map([["testDomain.eth", signers[6].address]])
                    })
                ]
            }
        });
        const commentToSign = createCommentToSign({
            communityAddress: signers[0].address,
            author: { name: "testDomain.eth" },
            signer: signers[1],
            content: "domain identity claim"
        });
        const signedPublication = {
            ...remeda.omit(commentToSign, ["signer", "communityAddress"]),
            signature: await signComment({ comment: commentToSign, pkc: tempPKC })
        } satisfies CommentPubsubMessagePublication;

        const verification = await verifyCommentPubsubMessage({
            comment: signedPublication,
            resolveAuthorNames: tempPKC.resolveAuthorNames,
            clientsManager: tempPKC._clientsManager
        });
        expect(verification).to.deep.equal({ valid: true });
        expect(signedPublication.author?.name).to.equal("testDomain.eth");
        await tempPKC.destroy();
    });
    it(`verifyCommentIpfs returns valid when author domain resolves to different address (nameResolved handles display)`, async () => {
        const comment = remeda.clone(validCommentAuthorAddressDomainFixture) as CommentIpfsType;
        const tempPKC = await mockRemotePKC({
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [
                    createMockNameResolver({
                        records: new Map([["plebbit.eth", signers[7].address]])
                    })
                ]
            }
        });

        const verification = await verifyCommentIpfs({
            comment,
            resolveAuthorNames: tempPKC.resolveAuthorNames,
            clientsManager: tempPKC._clientsManager,
            calculatedCommentCid: "QmTest"
        });

        expect(verification).to.deep.equal({ valid: true });

        expect(comment.author.address).to.equal("plebbit.eth"); // address is immutable
        await tempPKC.destroy();
    });
});

// Clients of RPC will trust the response of RPC and won't validate
describeSkipIfRpc(`commentupdate`, async () => {
    let pkc: PKCType;
    let community: RemoteCommunity;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
        community = await pkc.getCommunity({ address: signers[0].address });
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Can validate live CommentUpdate`, async () => {
        const comment = await pkc.getComment({ cid: community.lastPostCid! });
        await comment.update();
        await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
        await comment.stop();
        // If a comment emits "update" that means the commentUpdate have been verified correctly

        const commentUpdateRecord = comment.raw.commentUpdate as CommentUpdateType;
        const commentForVerify: Pick<CommentIpfsWithCidPostCidDefined, "signature" | "postCid" | "depth" | "cid"> = {
            signature: comment.signature,
            postCid: comment.postCid,
            depth: comment.depth,
            cid: comment.cid!
        };
        expect(
            await verifyCommentUpdate({
                update: commentUpdateRecord,
                resolveAuthorNames: true,
                clientsManager: comment._clientsManager,
                community: community,
                comment: commentForVerify,
                validatePages: true,
                validateUpdateSignature: true
            })
        ).to.deep.equal({ valid: true });
    });

    it(`Fixture CommentUpdate can be signed by community and validated correctly`, async () => {
        const update = remeda.clone(validCommentUpdateFixture) as CommentUpdateType;
        const commentForVerify: Pick<CommentIpfsWithCidPostCidDefined, "signature" | "postCid" | "depth" | "cid"> = {
            cid: update.cid,
            postCid: undefined as unknown as string, // Post has no postCid
            depth: validCommentFixture.depth,
            signature: validCommentFixture.signature
        };
        update.signature = await signCommentUpdate({ update, signer: signers[0] }); // Same signer as the subplebbit that signed the CommentUpdate
        const verification = await verifyCommentUpdate({
            update,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: community._clientsManager,
            community: community,
            comment: commentForVerify,
            validatePages: true,
            validateUpdateSignature: true
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it(`CommentUpdate from previous pkc-js versions can be verified`, async () => {
        const update = remeda.clone(validCommentUpdateFixture) as CommentUpdateType;
        const commentForVerify: Pick<CommentIpfsWithCidPostCidDefined, "signature" | "postCid" | "depth" | "cid"> = {
            cid: update.cid,
            postCid: undefined as unknown as string,
            depth: validCommentFixture.depth,
            signature: validCommentFixture.signature
        };
        const verification = await verifyCommentUpdate({
            update,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: community._clientsManager,
            community: community,
            comment: commentForVerify,
            validatePages: true,
            validateUpdateSignature: true
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it(`verifyCommentUpdate invalidate commentUpdate if it was signed by other than community key`, async () => {
        const update = remeda.clone(validCommentUpdateFixture) as CommentUpdateType;
        const commentForVerify: Pick<CommentIpfsWithCidPostCidDefined, "signature" | "postCid" | "depth" | "cid"> = {
            cid: update.cid,
            postCid: undefined as unknown as string,
            depth: validCommentFixture.depth,
            signature: validCommentFixture.signature
        };
        update.signature = await signCommentUpdate({ update, signer: signers[6] }); // A different signer than subplebbit
        const verification = await verifyCommentUpdate({
            update,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: community._clientsManager,
            community: community,
            comment: commentForVerify,
            validatePages: true,
            validateUpdateSignature: true
        });
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_COMMENT_UPDATE_IS_NOT_SIGNED_BY_COMMUNITY });
    });

    it(`A commentUpdate with an edit signed by other than original author will be rejected`, async () => {
        const update = remeda.clone(validCommentUpdateWithAuthorEditFixture) as CommentUpdateType & {
            edit: { author?: { name?: string }; signature?: unknown; signer?: unknown };
        };
        const commentForVerify: Pick<CommentIpfsWithCidPostCidDefined, "signature" | "postCid" | "depth" | "cid"> = {
            cid: update.cid,
            postCid: undefined as unknown as string,
            depth: validCommentWithAuthorEditFixture.depth,
            signature: validCommentWithAuthorEditFixture.signature
        };
        expect(
            await verifyCommentUpdate({
                update: update as CommentUpdateType,
                resolveAuthorNames: pkc.resolveAuthorNames,
                clientsManager: community._clientsManager,
                community: community,
                comment: commentForVerify,
                validatePages: false,
                validateUpdateSignature: true
            })
        ).to.deep.equal({ valid: true });
        update.edit.author = { name: "attacker.eth" };
        update.edit.signature = await signCommentEdit({
            edit: {
                ...update.edit,
                signer: signers[7],
                communityAddress: (update.edit as Record<string, unknown>).subplebbitAddress as string
            } as Parameters<typeof signCommentEdit>[0]["edit"],
            pkc: pkc
        });
        const verification = await verifyCommentUpdate({
            update: update as CommentUpdateType,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: community._clientsManager,
            community: community,
            comment: commentForVerify,
            validatePages: true,
            validateUpdateSignature: true
        });
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
    });

    it(`commentUpdate.edit is invalidated if any prop is changed and not signed by original author`, async () => {
        const update = remeda.clone(validCommentUpdateWithAuthorEditFixture) as CommentUpdateType & { edit: { content: string } };
        const commentForVerify: Pick<CommentIpfsWithCidPostCidDefined, "signature" | "postCid" | "depth" | "cid"> = {
            cid: update.cid,
            postCid: undefined as unknown as string,
            depth: validCommentWithAuthorEditFixture.depth,
            signature: validCommentWithAuthorEditFixture.signature
        };
        expect(
            await verifyCommentUpdate({
                update: update as CommentUpdateType,
                resolveAuthorNames: pkc.resolveAuthorNames,
                clientsManager: community._clientsManager,
                community: community,
                comment: commentForVerify,
                validatePages: true,
                validateUpdateSignature: true
            })
        ).to.deep.equal({ valid: true });
        update.edit.content += "12345"; // Invalidate signature
        update.signature = await signCommentUpdate({ update: update as CommentUpdateType, signer: signers[6] }); // A different signer than subplebbit and author

        const verification = await verifyCommentUpdate({
            update: update as CommentUpdateType,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: community._clientsManager,
            community: community,
            comment: commentForVerify,
            validatePages: true,
            validateUpdateSignature: true
        });
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_COMMENT_UPDATE_EDIT_SIGNATURE_IS_INVALID });
    });
});

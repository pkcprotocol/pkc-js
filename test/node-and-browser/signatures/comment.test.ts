import { beforeAll, afterAll } from "vitest";
import { mockRemotePlebbit, describeSkipIfRpc, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
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
import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type {
    CommentOptionsToSign,
    CommentPubsubMessagePublication,
    CommentIpfsType,
    CommentIpfsWithCidPostCidDefined,
    CommentUpdateType
} from "../../../dist/node/publications/comment/types.js";
import type { RemoteSubplebbit } from "../../../dist/node/subplebbit/remote-subplebbit.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

// Protocol version constant
const PROTOCOL_VERSION = "1.0.0";

const fixtureSignature = {
    signature: "RTBNJ8bEnvEENOAxzk3pqxc9I3a0M9H7qlXsL5yu2frEEbJKqf789eFVnmyccmB99hyBb1Hyw5Soqma+RIxIAw",
    publicKey: "CFhuD55tmzZjWZ113tZbDw/AsuNDkgSdvCCbPeqiF10",
    type: "ed25519",
    signedPropertyNames: Object.keys(fixtureComment).sort()
};

// Helper to create a comment with all required fields for signing
function createCommentToSign(opts: {
    subplebbitAddress: string;
    author: { address: string };
    signer: (typeof signers)[0];
    title?: string;
    content?: string;
}): CommentOptionsToSign {
    return {
        subplebbitAddress: opts.subplebbitAddress,
        author: opts.author,
        timestamp: timestamp(),
        protocolVersion: PROTOCOL_VERSION,
        title: opts.title ?? "Test post signature",
        content: opts.content ?? "some content...",
        signer: opts.signer
    };
}

describe("sign comment", async () => {
    let plebbit: PlebbitType;
    let signedCommentClone: CommentPubsubMessagePublication;
    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it("Can sign a comment with randomly generated key", async () => {
        const signer = await plebbit.createSigner();

        const comment = createCommentToSign({
            subplebbitAddress: signers[0].address,
            author: { address: signer.address },
            signer
        });
        const signature = await signComment({ comment, plebbit });
        expect(signature.publicKey).to.equal(signer.publicKey);
        const signedComment: CommentPubsubMessagePublication = { signature, ...remeda.omit(comment, ["signer"]) };
        const verificaiton = await verifyCommentPubsubMessage({
            comment: signedComment,
            resolveAuthorNames: plebbit.resolveAuthorNames,
            clientsManager: plebbit._clientsManager,
            overrideAuthorAddressIfInvalid: false
        });
        expect(verificaiton).to.deep.equal({ valid: true });
        signedCommentClone = remeda.clone(signedComment);
    });

    it("Can sign a comment with an imported key", async () => {
        const signer = await plebbit.createSigner({ privateKey: signers[1].privateKey, type: "ed25519" });
        const comment = createCommentToSign({
            subplebbitAddress: signers[0].address,
            author: { address: signer.address },
            signer
        });
        const signature = await signComment({ comment, plebbit });
        const signedComment: CommentPubsubMessagePublication = { signature, ...remeda.omit(comment, ["signer"]) };
        expect(signedComment.signature.publicKey).to.be.equal(signers[1].publicKey, "Generated public key should be same as provided");
        const verificaiton = await verifyCommentPubsubMessage({
            comment: signedComment,
            resolveAuthorNames: plebbit.resolveAuthorNames,
            clientsManager: plebbit._clientsManager,
            overrideAuthorAddressIfInvalid: false
        });
        expect(verificaiton).to.deep.equal({ valid: true });
    });

    it("signComment author signature is correct", async () => {
        // Note: fixtureComment doesn't have protocolVersion, and the expected signature was computed without it
        // We cast to CommentOptionsToSign to satisfy types while testing with historical fixture
        const commentToSign = { ...fixtureComment, signer: signers[1] } as CommentOptionsToSign;
        const authorSignature = await signComment({ comment: commentToSign, plebbit });
        expect(authorSignature).to.exist;
        expect(authorSignature.signature).to.equal(fixtureSignature.signature);
        expect(authorSignature.publicKey).to.equal(fixtureSignature.publicKey);
        expect(authorSignature.type).to.equal(fixtureSignature.type);
        expect(authorSignature.signedPropertyNames.sort()).to.deep.equal(fixtureSignature.signedPropertyNames);
    });

    it(`signComment throws with invalid author`, async () => {
        const randomSigner = signers[3];
        // Trying to sign a publication with author.address !== randomSigner.address
        // should throw an error
        try {
            const commentToSign = { ...fixtureComment, signer: randomSigner } as CommentOptionsToSign;
            await signComment({ comment: commentToSign, plebbit });
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_AUTHOR_ADDRESS_NOT_MATCHING_SIGNER");
        }
    });

    it(`signComment throws with author.address not being an IPNS or domain`, async () => {
        const cloneComment = remeda.clone(signedCommentClone);
        (cloneComment as { signature?: unknown }).signature = undefined;
        cloneComment.author.address = "gibbreish";
        try {
            const commentToSign: CommentOptionsToSign = { ...cloneComment, protocolVersion: PROTOCOL_VERSION, signer: signers[7] };
            await signComment({ comment: commentToSign, plebbit });
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_AUTHOR_ADDRESS_NOT_MATCHING_SIGNER");
        }
    });
    it(`signComment throws with author.address=undefined`, async () => {
        const cloneComment = remeda.clone(signedCommentClone);
        (cloneComment as { signature?: unknown }).signature = undefined;
        (cloneComment.author as { address: string | undefined }).address = undefined;
        try {
            const commentToSign = { ...cloneComment, protocolVersion: PROTOCOL_VERSION, signer: signers[7] } as CommentOptionsToSign;
            await signComment({ comment: commentToSign, plebbit });
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_AUTHOR_ADDRESS_UNDEFINED");
        }
    });
    it("can sign a comment with author.displayName = undefined", async () => {
        const signer = signers[4];

        const comment = createCommentToSign({
            subplebbitAddress: signer.address,
            author: { address: signer.address },
            signer,
            title: "comment title",
            content: "comment content"
        });
        // Override timestamp for deterministic test
        (comment as { timestamp: number }).timestamp = 12345678;
        const signature = await signComment({ comment, plebbit });
        const signedComment: CommentPubsubMessagePublication = { signature, ...remeda.omit(comment, ["signer"]) };
        const res = await verifyCommentPubsubMessage({
            comment: signedComment,
            resolveAuthorNames: plebbit.resolveAuthorNames,
            clientsManager: plebbit._clientsManager,
            overrideAuthorAddressIfInvalid: false
        });
        expect(res).to.deep.equal({ valid: true });
    });
});

// Clients of RPC will trust the response of RPC and won't validate
describeSkipIfRpc("verify Comment", async () => {
    let plebbit: PlebbitType;
    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`Valid signature fixture is validated correctly`, async () => {
        // Note: fixtureComment doesn't have protocolVersion, and the fixtureSignature was computed without it
        const fixtureWithSignature = { ...fixtureComment, signature: fixtureSignature } as CommentPubsubMessagePublication;
        const verification = await verifyCommentPubsubMessage({
            comment: fixtureWithSignature,
            resolveAuthorNames: plebbit.resolveAuthorNames,
            clientsManager: plebbit._clientsManager,
            overrideAuthorAddressIfInvalid: false
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it("verifyCommentPubsubMessage failure with wrong signature", async () => {
        const invalidSignature = remeda.clone(fixtureSignature);
        invalidSignature.signature += "1";

        // Note: fixtureComment doesn't have protocolVersion
        const wronglySignedPublication = { ...fixtureComment, signature: invalidSignature } as CommentPubsubMessagePublication;
        const verification = await verifyCommentPubsubMessage({
            comment: wronglySignedPublication,
            resolveAuthorNames: plebbit.resolveAuthorNames,
            clientsManager: plebbit._clientsManager,
            overrideAuthorAddressIfInvalid: false
        });
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
    });

    it(`Valid Comment fixture from previous plebbit-js version is validated correctly`, async () => {
        const comment = remeda.clone(validCommentFixture) as CommentIpfsType;

        const verification = await verifyCommentIpfs({
            comment,
            clientsManager: plebbit._clientsManager,
            resolveAuthorNames: false,
            calculatedCommentCid: "QmTest",
            overrideAuthorAddressIfInvalid: false
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it(`A comment with avatar fixture is validated correctly`, async () => {
        const comment = remeda.clone(validCommentAvatarFixture) as CommentIpfsType;
        const verification = await verifyCommentIpfs({
            comment,
            clientsManager: plebbit._clientsManager,
            resolveAuthorNames: true,
            calculatedCommentCid: "QmTest",
            overrideAuthorAddressIfInvalid: false
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it(`verifyCommentPubsubMessage invalidates a comment with author.address not a domain or IPNS`, async () => {
        // Note: fixtureComment doesn't have protocolVersion
        const comment = remeda.clone({ ...fixtureComment, signature: fixtureSignature }) as CommentPubsubMessagePublication;
        comment.author.address = "gibbresish"; // Not a domain or IPNS
        const verification = await verifyCommentPubsubMessage({
            comment,
            resolveAuthorNames: plebbit.resolveAuthorNames,
            clientsManager: plebbit._clientsManager,
            overrideAuthorAddressIfInvalid: false
        });
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_AUTHOR_ADDRESS_IS_NOT_A_DOMAIN_OR_B58 });
    });
    it("verifyCommentPubsubMessage invalidates a comment with author.address = undefined", async () => {
        // Note: fixtureComment doesn't have protocolVersion
        const comment = remeda.clone({ ...fixtureComment, signature: fixtureSignature }) as CommentPubsubMessagePublication;
        (comment.author as { address: string | undefined }).address = undefined; // Not a domain or IPNS
        const verification = await verifyCommentPubsubMessage({
            comment,
            resolveAuthorNames: plebbit.resolveAuthorNames,
            clientsManager: plebbit._clientsManager,
            overrideAuthorAddressIfInvalid: false
        });
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_AUTHOR_ADDRESS_UNDEFINED });
    });

    it(`Can sign and verify a comment with flairs`, async () => {
        const signer = await plebbit.createSigner();
        const commentToSign: CommentOptionsToSign = {
            subplebbitAddress: signers[0].address,
            author: { address: signer.address },
            timestamp: timestamp(),
            protocolVersion: PROTOCOL_VERSION,
            title: "Post with flairs",
            content: "Testing flairs",
            flairs: [{ text: "Discussion" }, { text: "Verified", backgroundColor: "#00ff00" }],
            signer
        };
        const signature = await signComment({ comment: commentToSign, plebbit });
        const signedComment: CommentPubsubMessagePublication = { signature, ...remeda.omit(commentToSign, ["signer"]) };
        const verification = await verifyCommentPubsubMessage({
            comment: signedComment,
            resolveAuthorNames: plebbit.resolveAuthorNames,
            clientsManager: plebbit._clientsManager,
            overrideAuthorAddressIfInvalid: false
        });
        expect(verification).to.deep.equal({ valid: true });
        expect(signedComment.signature.signedPropertyNames).to.include("flairs");
    });

    it(`Can verify a comment whose author.flairs have been changed`, async () => {
        const signer = await plebbit.createSigner();
        const commentToSign: CommentOptionsToSign = {
            subplebbitAddress: signers[0].address,
            author: { address: signer.address, flairs: [{ text: "Original" }] },
            timestamp: timestamp(),
            protocolVersion: PROTOCOL_VERSION,
            title: "Post with author flairs",
            content: "Testing author flairs",
            signer
        };
        const signature = await signComment({ comment: commentToSign, plebbit });
        const signedComment: CommentPubsubMessagePublication = { signature, ...remeda.omit(commentToSign, ["signer"]) };

        // Tamper with author.flairs
        signedComment.author.flairs = [{ text: "Tampered" }];
        const verification = await verifyCommentPubsubMessage({
            comment: signedComment,
            resolveAuthorNames: plebbit.resolveAuthorNames,
            clientsManager: plebbit._clientsManager,
            overrideAuthorAddressIfInvalid: false
        });
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
    });

    it(`can verify a comment whose flairs have been changed by mod`, async () => {
        // Signing a comment with flairs, then modifying the flairs should invalidate the signature
        const signer = await plebbit.createSigner();
        const commentToSign: CommentOptionsToSign = {
            subplebbitAddress: signers[0].address,
            author: { address: signer.address },
            timestamp: timestamp(),
            protocolVersion: PROTOCOL_VERSION,
            title: "Post to be mod-flaired",
            content: "Testing mod flairs tampering",
            flairs: [{ text: "Original" }],
            signer
        };
        const signature = await signComment({ comment: commentToSign, plebbit });
        const signedComment: CommentPubsubMessagePublication = { signature, ...remeda.omit(commentToSign, ["signer"]) };

        // Tamper with flairs as if a mod changed them
        signedComment.flairs = [{ text: "Mod Changed" }];
        const verification = await verifyCommentPubsubMessage({
            comment: signedComment,
            resolveAuthorNames: plebbit.resolveAuthorNames,
            clientsManager: plebbit._clientsManager,
            overrideAuthorAddressIfInvalid: false
        });
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
    });
});

// Clients of RPC will trust the response of RPC and won't validate
describeSkipIfRpc(`Comment with author.address as domain`, async () => {
    it(`verifyCommentPubsubMessage corrects author.address(domain) if it resolves to a different author (overrideAuthorAddressIfInvalid=true)`, async () => {
        const tempPlebbit = await mockRemotePlebbit();
        tempPlebbit._clientsManager.resolveAuthorNameIfNeeded = async (authorAddress: string) =>
            authorAddress === "testDomain.eth" ? fixtureComment.author.address : authorAddress;
        const commentWithInvalidDomain = remeda.clone(fixtureComment);
        commentWithInvalidDomain.author.address = "testDomain.eth";
        // Note: fixtureComment doesn't have protocolVersion
        const commentToSign = { ...commentWithInvalidDomain, signer: signers[1] } as CommentOptionsToSign;
        const signedPublication = {
            ...remeda.omit(commentToSign, ["signer"]),
            signature: await signComment({ comment: commentToSign, plebbit: tempPlebbit })
        } as CommentPubsubMessagePublication;
        tempPlebbit._clientsManager.resolveAuthorNameIfNeeded = async (authorAddress: string) =>
            authorAddress === "testDomain.eth" ? signers[6].address : authorAddress; // testDomain.eth no longer points to the same author

        const verificaiton = await verifyCommentPubsubMessage({
            comment: signedPublication,
            resolveAuthorNames: tempPlebbit.resolveAuthorNames,
            clientsManager: tempPlebbit._clientsManager,
            overrideAuthorAddressIfInvalid: true
        });
        expect(verificaiton).to.deep.equal({ valid: true, derivedAddress: signers[1].address });
        expect(signedPublication.author.address).to.equal(fixtureComment.author.address); // It has been corrected to the original signer even though resolver is resolving to signers[6]
        await tempPlebbit.destroy();
    });
    it(`Comment with invalid author domain address will will be invalidated (overrideAuthorAddressIfInvalid=false)`, async () => {
        const comment = remeda.clone(validCommentAuthorAddressDomainFixture) as CommentIpfsType;
        const tempPlebbit = await mockRemotePlebbit();
        tempPlebbit._clientsManager.resolveAuthorNameIfNeeded = async (authorAddress: string) =>
            authorAddress === "plebbit.eth" ? signers[7].address : authorAddress; // This would invalidate the fixture author address. Should be corrected

        const verification = await verifyCommentIpfs({
            comment,
            resolveAuthorNames: tempPlebbit.resolveAuthorNames,
            clientsManager: tempPlebbit._clientsManager,
            overrideAuthorAddressIfInvalid: false,
            calculatedCommentCid: "QmTest"
        });

        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_AUTHOR_NOT_MATCHING_SIGNATURE });

        expect(comment.author.address).to.equal("plebbit.eth"); // should remain the same
        await tempPlebbit.destroy();
    });
});

// Clients of RPC will trust the response of RPC and won't validate
describeSkipIfRpc(`commentupdate`, async () => {
    let plebbit: PlebbitType;
    let subplebbit: RemoteSubplebbit;
    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
        subplebbit = await plebbit.getSubplebbit({ address: signers[0].address });
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`Can validate live CommentUpdate`, async () => {
        const comment = await plebbit.getComment({ cid: subplebbit.lastPostCid! });
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
                subplebbit: subplebbit,
                comment: commentForVerify,
                overrideAuthorAddressIfInvalid: false,
                validatePages: true,
                validateUpdateSignature: true
            })
        ).to.deep.equal({ valid: true });
    });

    it(`Fixture CommentUpdate can be signed by subplebbit and validated correctly`, async () => {
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
            resolveAuthorNames: plebbit.resolveAuthorNames,
            clientsManager: subplebbit._clientsManager,
            subplebbit: subplebbit,
            comment: commentForVerify,
            overrideAuthorAddressIfInvalid: false,
            validatePages: true,
            validateUpdateSignature: true
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it(`CommentUpdate from previous plebbit-js versions can be verified`, async () => {
        const update = remeda.clone(validCommentUpdateFixture) as CommentUpdateType;
        const commentForVerify: Pick<CommentIpfsWithCidPostCidDefined, "signature" | "postCid" | "depth" | "cid"> = {
            cid: update.cid,
            postCid: undefined as unknown as string,
            depth: validCommentFixture.depth,
            signature: validCommentFixture.signature
        };
        const verification = await verifyCommentUpdate({
            update,
            resolveAuthorNames: plebbit.resolveAuthorNames,
            clientsManager: subplebbit._clientsManager,
            subplebbit: subplebbit,
            comment: commentForVerify,
            overrideAuthorAddressIfInvalid: false,
            validatePages: true,
            validateUpdateSignature: true
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it(`verifyCommentUpdate invalidate commentUpdate if it was signed by other than subplebbit key`, async () => {
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
            resolveAuthorNames: plebbit.resolveAuthorNames,
            clientsManager: subplebbit._clientsManager,
            subplebbit: subplebbit,
            comment: commentForVerify,
            overrideAuthorAddressIfInvalid: false,
            validatePages: true,
            validateUpdateSignature: true
        });
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_COMMENT_UPDATE_IS_NOT_SIGNED_BY_SUBPLEBBIT });
    });

    it(`A commentUpdate with an edit signed by other than original author will be rejected`, async () => {
        const update = remeda.clone(validCommentUpdateWithAuthorEditFixture) as CommentUpdateType & {
            edit: { author: { address: string }; signature?: unknown; signer?: unknown };
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
                resolveAuthorNames: plebbit.resolveAuthorNames,
                clientsManager: subplebbit._clientsManager,
                subplebbit: subplebbit,
                comment: commentForVerify,
                overrideAuthorAddressIfInvalid: false,
                validatePages: false,
                validateUpdateSignature: true
            })
        ).to.deep.equal({ valid: true });
        update.edit.author.address = signers[7].address;
        update.edit.signature = await signCommentEdit({
            edit: { ...update.edit, signer: signers[7] } as Parameters<typeof signCommentEdit>[0]["edit"],
            plebbit
        });
        const verification = await verifyCommentUpdate({
            update: update as CommentUpdateType,
            resolveAuthorNames: plebbit.resolveAuthorNames,
            clientsManager: subplebbit._clientsManager,
            subplebbit: subplebbit,
            comment: commentForVerify,
            overrideAuthorAddressIfInvalid: false,
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
                resolveAuthorNames: plebbit.resolveAuthorNames,
                clientsManager: subplebbit._clientsManager,
                subplebbit: subplebbit,
                comment: commentForVerify,
                overrideAuthorAddressIfInvalid: false,
                validatePages: true,
                validateUpdateSignature: true
            })
        ).to.deep.equal({ valid: true });
        update.edit.content += "12345"; // Invalidate signature
        update.signature = await signCommentUpdate({ update: update as CommentUpdateType, signer: signers[6] }); // A different signer than subplebbit and author

        const verification = await verifyCommentUpdate({
            update: update as CommentUpdateType,
            resolveAuthorNames: plebbit.resolveAuthorNames,
            clientsManager: subplebbit._clientsManager,
            subplebbit: subplebbit,
            comment: commentForVerify,
            overrideAuthorAddressIfInvalid: false,
            validatePages: true,
            validateUpdateSignature: true
        });
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_COMMENT_UPDATE_EDIT_SIGNATURE_IS_INVALID });
    });
});

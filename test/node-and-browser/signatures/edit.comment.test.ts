import { beforeAll, afterAll } from "vitest";
import { mockRemotePKC, describeSkipIfRpc } from "../../../dist/node/test/test-util.js";
import signers from "../../fixtures/signers.js";
import { timestamp } from "../../../dist/node/util.js";
import * as remeda from "remeda";
import { messages } from "../../../dist/node/errors.js";
import { verifyCommentEdit, signCommentEdit } from "../../../dist/node/signer/signatures.js";
import validCommentEditFixture from "../../fixtures/signatures/commentEdit/valid_comment_edit.json" with { type: "json" };
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { CommentEditOptionsToSign, CommentEditPubsubMessagePublication } from "../../../dist/node/publications/comment-edit/types.js";

describe("Sign commentedit", async () => {
    let pkc: PKCType;
    let community: RemoteCommunity;
    let editProps: CommentEditOptionsToSign;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
        community = await pkc.getCommunity({ address: signers[0].address });
        editProps = {
            author: { displayName: "Editor" },
            communityAddress: community.address,
            commentCid: community.lastPostCid!,
            reason: "New comment edit",
            content: "Just so",
            signer: signers[7],
            timestamp: timestamp(),
            protocolVersion: "1.0.0"
        };
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`pkc.createCommentEdit creates a valid CommentEdit`, async () => {
        const commentEdit = await pkc.createCommentEdit(editProps);
        expect(commentEdit.signature).to.be.an("object");
        expect(commentEdit.raw.pubsubMessageToPublish).to.be.an("object");
        expect(commentEdit.raw.pubsubMessageToPublish!.communityPublicKey).to.equal(community.address);
        expect(commentEdit.toJSONPubsubRequestToEncrypt().commentEdit).to.deep.equal(commentEdit.raw.pubsubMessageToPublish);

        const verification = await verifyCommentEdit({
            edit: commentEdit.raw.pubsubMessageToPublish as CommentEditPubsubMessagePublication,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it(`signCommentEdit throws with author.name not being a domain`, async () => {
        const cloneEdit = remeda.clone(editProps);
        cloneEdit.author = { name: "gibbreish" };
        try {
            await signCommentEdit({ edit: { ...cloneEdit, signer: signers[7] }, pkc: pkc });
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_AUTHOR_ADDRESS_IS_NOT_A_DOMAIN_OR_B58");
        }
    });
    it(`signCommentEdit allows author to be omitted`, async () => {
        const signature = await signCommentEdit({
            edit: { ...remeda.omit(editProps, ["author"]), signer: signers[7] } as CommentEditOptionsToSign,
            pkc: pkc
        });
        expect(signature.publicKey).to.equal(signers[7].publicKey);
    });
});

// Clients of RPC will trust the response of RPC and won't validate
describeSkipIfRpc("Verify CommentEdit", async () => {
    let pkc: PKCType;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
        await pkc.createCommentEdit(validCommentEditFixture as unknown as CommentEditPubsubMessagePublication); // should throw if it has an invalid schema
    });
    it(`Valid CommentEdit signature fixture is validated correctly`, async () => {
        const edit = remeda.clone(validCommentEditFixture) as CommentEditPubsubMessagePublication;
        const verification = await verifyCommentEdit({
            edit,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it(`Invalid CommentEdit signature gets invalidated correctly`, async () => {
        const edit = remeda.clone(validCommentEditFixture) as CommentEditPubsubMessagePublication & { reason: string };
        edit.reason += "1234"; // Should invalidate comment edit
        const verification = await verifyCommentEdit({
            edit,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
    });

    it(`verifyCommentEdit invalidates a commentEdit with tampered author.name`, async () => {
        const edit = remeda.clone(validCommentEditFixture) as CommentEditPubsubMessagePublication;
        edit.author = { ...(edit.author || {}), name: "gibbresish" };
        const verification = await verifyCommentEdit({
            edit,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        // Modifying author.name without re-signing invalidates the signature
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
    });
    it("verifyCommentEdit invalidates a legacy commentEdit with author removed because the signature changes", async () => {
        const edit = remeda.clone(validCommentEditFixture) as CommentEditPubsubMessagePublication;
        delete edit.author;
        const verification = await verifyCommentEdit({
            edit,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
    });
});

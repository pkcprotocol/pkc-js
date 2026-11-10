// Issue #401: what client page verification accepts today for a page comment whose signed community fields
// (communityPublicKey / communityName) differ from the community the page belongs to. The server-side page
// filter must never publish a row that this verification rejects, so these cases pin the client rule down.
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import Logger from "@pkcprotocol/pkc-logger";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { mockPKCNoDataPathWithOnlyKuboClient } from "../../../dist/node/test/test-util.js";
import { signCommentUpdate, verifyPageComment } from "../../../dist/node/signer/signatures.js";
import { messages } from "../../../dist/node/errors.js";
import { timestamp } from "../../../dist/node/util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PageIpfs } from "../../../dist/node/pages/types.js";
import type { SignerType } from "../../../dist/node/signer/types.js";

// Free signer/verify helpers and raw clients take a required log (issue #493); tests use the process-default root
const testLog = Logger({ namespace: "pkc-js:test:community-identity-page-verification" });

const communityName = "memes.bso";

describe("page verification of a comment's community fields (#401)", () => {
    let pkc: PKC;
    let communitySigner: SignerType;
    let otherCommunitySigner: SignerType;

    beforeAll(async () => {
        pkc = await mockPKCNoDataPathWithOnlyKuboClient();
        communitySigner = await pkc.createSigner();
        otherCommunitySigner = await pkc.createSigner();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    // A post signed by its author with the given community fields, plus a CommentUpdate signed by the community
    const createPagePost = async (communityFields: { communityPublicKey: string; communityName?: string }) => {
        const post = await pkc.createComment({
            ...communityFields,
            signer: await pkc.createSigner(),
            title: `title ${Math.random()}`,
            content: `content ${Math.random()}`
        });
        const commentIpfs = { ...post.raw.pubsubMessageToPublish!, depth: 0 };
        expect(commentIpfs.communityPublicKey).to.equal(communityFields.communityPublicKey);
        expect(commentIpfs.communityName).to.equal(communityFields.communityName);
        const cid = await calculateIpfsHash(deterministicStringify(commentIpfs)!);
        const updateWithoutSignature = {
            cid,
            upvoteCount: 0,
            downvoteCount: 0,
            replyCount: 0,
            updatedAt: timestamp(),
            protocolVersion: commentIpfs.protocolVersion
        };
        const commentUpdate = {
            ...updateWithoutSignature,
            signature: await signCommentUpdate({ update: updateWithoutSignature, signer: communitySigner, log: testLog })
        };
        return { comment: commentIpfs, commentUpdate } as unknown as PageIpfs["comments"][0];
    };

    const verify = (pageComment: PageIpfs["comments"][0], community: { publicKey: string; name?: string }) =>
        verifyPageComment({
            pageComment,
            community,
            parentComment: undefined,
            resolveAuthorNames: false,
            clientsManager: pkc._clientsManager,
            validatePages: true,
            validateUpdateSignature: true,
            log: testLog
        });

    describe("community without a name", () => {
        it("accepts a row signed with the community's key and no name", async () => {
            const row = await createPagePost({ communityPublicKey: communitySigner.address });
            expect(await verify(row, { publicKey: communitySigner.address })).to.deep.equal({ valid: true });
        });

        it("accepts a row signed with the community's key and a name (the community dropped its name)", async () => {
            const row = await createPagePost({ communityPublicKey: communitySigner.address, communityName });
            expect(await verify(row, { publicKey: communitySigner.address })).to.deep.equal({ valid: true });
        });

        it("rejects a row signed with a different key", async () => {
            const row = await createPagePost({ communityPublicKey: otherCommunitySigner.address });
            expect(await verify(row, { publicKey: communitySigner.address })).to.deep.equal({
                valid: false,
                reason: messages.ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_COMMUNITY
            });
        });
    });

    describe("community with a name", () => {
        it("accepts a row signed with the community's key and its name", async () => {
            const row = await createPagePost({ communityPublicKey: communitySigner.address, communityName });
            expect(await verify(row, { publicKey: communitySigner.address, name: communityName })).to.deep.equal({ valid: true });
        });

        it("accepts a row signed with the community's key and no name (the name was added later)", async () => {
            const row = await createPagePost({ communityPublicKey: communitySigner.address });
            expect(await verify(row, { publicKey: communitySigner.address, name: communityName })).to.deep.equal({ valid: true });
        });

        // A named community checks only the name, so a row signed for a rotated-away key still verifies (ac3fb677e)
        it("accepts a row signed with a different key and no name", async () => {
            const row = await createPagePost({ communityPublicKey: otherCommunitySigner.address });
            expect(await verify(row, { publicKey: communitySigner.address, name: communityName })).to.deep.equal({ valid: true });
        });

        it("accepts a row signed with a different key and the community's name", async () => {
            const row = await createPagePost({ communityPublicKey: otherCommunitySigner.address, communityName });
            expect(await verify(row, { publicKey: communitySigner.address, name: communityName })).to.deep.equal({ valid: true });
        });

        it("rejects a row signed with a different name", async () => {
            const row = await createPagePost({ communityPublicKey: communitySigner.address, communityName: "other.bso" });
            expect(await verify(row, { publicKey: communitySigner.address, name: communityName })).to.deep.equal({
                valid: false,
                reason: messages.ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_COMMUNITY
            });
        });
    });
});

import { beforeAll, afterAll } from "vitest";
import { mockRemotePKC, describeSkipIfRpc, createMockNameResolver } from "../../../dist/node/test/test-util.js";
import { verifyPage } from "../../../dist/node/signer/signatures.js";
import { messages } from "../../../dist/node/errors.js";
import signers from "../../fixtures/signers.js";
import * as remeda from "remeda";
import { v4 as uuidV4 } from "uuid";

import validPageIpfsFixture from "../../fixtures/valid_page.json" with { type: "json" };
import legacyPageIpfsFixture from "../../fixtures/valid_page_legacy_subplebbitAddress.json" with { type: "json" };

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { PageIpfs } from "../../../dist/node/pages/types.js";

const subAddress = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";

// When parentCid is undefined, it means we're verifying a community posts page (depth -1)
const getParentComment = (parentCid: string | undefined) => {
    if (parentCid === undefined) {
        return { cid: undefined as undefined, depth: -1 as const, postCid: undefined as undefined };
    }
    // For nested pages, we'd need more info, but in these tests we only use undefined
    return { cid: undefined as undefined, depth: -1 as const, postCid: undefined as undefined };
};

const verifyPageJsonAlongWithObject = async (
    pageJson: PageIpfs,
    pkc: PKCType,
    community: RemoteCommunity,
    parentCid: string | undefined
) => {
    // randomize pageCid so that we don't rely on cache
    const parentComment = getParentComment(parentCid);
    const pageObjRes = await verifyPage({
        pageCid: uuidV4(),
        pageSortName: "hot",
        page: JSON.parse(JSON.stringify(pageJson)),
        resolveAuthorNames: pkc.resolveAuthorNames,
        clientsManager: pkc._clientsManager,
        community: community,
        parentComment,
        validatePages: true,
        validateUpdateSignature: true
    });
    const pageJsonRes = await verifyPage({
        pageCid: uuidV4(),
        pageSortName: "hot",
        page: pageJson,
        resolveAuthorNames: pkc.resolveAuthorNames,
        clientsManager: pkc._clientsManager,
        community: community,
        parentComment,
        validatePages: true,
        validateUpdateSignature: true
    });
    expect(pageObjRes).to.deep.equal(pageJsonRes);
    return pageObjRes;
};

// RPC tests don't need to run this because clients of RPC trust RPC response and won't validate

describeSkipIfRpc(`verify pages`, async () => {
    let pkc: PKCType;
    let community: RemoteCommunity;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
        community = await pkc.getCommunity({ address: subAddress });
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Can validate page from live community`, async () => {
        const page = community.raw.communityIpfs.posts.pages.hot;
        const pageVerification = await verifyPageJsonAlongWithObject(page, pkc, community, undefined);
        expect(pageVerification).to.deep.equal({ valid: true });
    });

    it(`Page from previous plebbit-js versions can be validated`, async () => {
        const page = remeda.clone(legacyPageIpfsFixture) as PageIpfs;
        const verification = await verifyPageJsonAlongWithObject(page, pkc, community, undefined);
        expect(verification).to.deep.equal({ valid: true });
    });

    it(`verifyPage will return valid when comment.author.name (domain) resolves to address different than the signer's`, async () => {
        // verifyPage would override the incorrect domain
        const invalidPage = remeda.clone(validPageIpfsFixture) as PageIpfs;
        // New wire format uses author.name for domains
        const commentWithDomainIndex = invalidPage.comments.findIndex(
            (pageComment) => typeof pageComment.comment.author?.name === "string"
        );
        expect(commentWithDomainIndex).to.be.greaterThanOrEqual(0);
        const domainName = invalidPage.comments[commentWithDomainIndex].comment.author!.name!;

        const tempPKC: PKCType = await mockRemotePKC({
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [
                    createMockNameResolver({
                        records: new Map([[domainName, signers[3].address]]), // Resolve to wrong address intentionally
                        includeDefaultRecords: true
                    })
                ]
            }
        });

        const verification = await verifyPageJsonAlongWithObject(invalidPage, tempPKC, community, undefined);
        expect(verification).to.deep.equal({ valid: true });
        expect(invalidPage.comments[commentWithDomainIndex].comment.author!.name).to.equal(domainName);
        await tempPKC.destroy();
    });

    describe(`A sub owner changing any of comment fields in page will invalidate`, async () => {
        beforeAll(async () => {
            const page = remeda.clone(validPageIpfsFixture) as PageIpfs;
            const verificaiton = await verifyPageJsonAlongWithObject(page, pkc, community, undefined);
            expect(verificaiton).to.deep.equal({ valid: true });
        });

        it(`comment.flairs (original)`, async () => {
            const invalidPage = remeda.clone(validPageIpfsFixture) as PageIpfs;
            // Add flairs to a comment that had none — changing the comment object changes its CID hash,
            // so the commentUpdate.cid no longer matches
            invalidPage.comments[0].comment.flairs = [{ text: "Injected Flair" }];
            const verification = await verifyPageJsonAlongWithObject(invalidPage, pkc, community, undefined);
            expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_COMMENT_UPDATE_DIFFERENT_CID_THAN_COMMENT });
        });
        it("comment.content (author has never modified comment.content before))", async () => {
            const invalidPage = remeda.clone(validPageIpfsFixture) as PageIpfs;
            const commentWithNoEditIndex = invalidPage.comments.findIndex((pageComment) => !pageComment.commentUpdate.edit?.content);
            invalidPage.comments[commentWithNoEditIndex].comment.content = "Content modified by sub illegally";
            const verification = await verifyPageJsonAlongWithObject(invalidPage, pkc, community, undefined);
            expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
        });

        it(`comment.content (when author has modified comment.content before)`, async () => {
            // Use legacy fixture which has comments with commentUpdate.edit.content
            const invalidPage = remeda.clone(legacyPageIpfsFixture) as PageIpfs;
            const commentWithEditIndex = invalidPage.comments.findIndex((pageComment) => pageComment.commentUpdate.edit?.content);
            expect(commentWithEditIndex).to.be.greaterThanOrEqual(0);
            invalidPage.comments[commentWithEditIndex].comment.content = "Content modified by sub illegally";
            const verification = await verifyPageJsonAlongWithObject(invalidPage, pkc, community, undefined);
            expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
        });

        it(`commentUpdate.edit.content`, async () => {
            // Use legacy fixture which has comments with commentUpdate.edit.content
            const invalidPage = remeda.clone(legacyPageIpfsFixture) as PageIpfs;
            const commentWithEditIndex = invalidPage.comments.findIndex((pageComment) => pageComment.commentUpdate.edit?.content);
            invalidPage.comments[commentWithEditIndex].commentUpdate.edit!.content = "Content modified by sub illegally";
            const verification = await verifyPageJsonAlongWithObject(invalidPage, pkc, community, undefined);
            expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
        });

        it(`commentUpdate.edit.spoiler`, async () => {
            // Use legacy fixture which has comments with commentUpdate.edit.spoiler
            const invalidPage = remeda.clone(legacyPageIpfsFixture) as PageIpfs;
            const commentWithSpoilerIndex = invalidPage.comments.findIndex((pageComment) => pageComment.commentUpdate.edit?.spoiler);
            expect(commentWithSpoilerIndex).to.be.greaterThanOrEqual(0);
            invalidPage.comments[commentWithSpoilerIndex].commentUpdate.edit!.spoiler =
                !invalidPage.comments[commentWithSpoilerIndex].commentUpdate.edit!.spoiler;
            const verification = await verifyPageJsonAlongWithObject(invalidPage, pkc, community, undefined);
            expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
        });

        it(`commentUpdate.edit.deleted`, async () => {
            // Use legacy fixture which has comments with commentUpdate.edit
            const invalidPage = remeda.clone(legacyPageIpfsFixture) as PageIpfs;
            const commentWithDeletedIndex = invalidPage.comments.findIndex((pageComment) => pageComment.commentUpdate.edit);
            expect(commentWithDeletedIndex).to.be.greaterThanOrEqual(0);
            invalidPage.comments[commentWithDeletedIndex].commentUpdate.edit!.deleted = !Boolean(
                invalidPage.comments[commentWithDeletedIndex].commentUpdate.edit!.deleted
            );
            const verification = await verifyPageJsonAlongWithObject(invalidPage, pkc, community, undefined);
            expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
        });

        it(`comment.link`, async () => {
            const invalidPage = remeda.clone(validPageIpfsFixture) as PageIpfs;
            const commentWithLinkIndex = invalidPage.comments.findIndex((pageComment) => pageComment.comment.link);
            expect(commentWithLinkIndex).to.be.greaterThanOrEqual(0);
            invalidPage.comments[commentWithLinkIndex].comment.link = "https://differentLinkzz.com";
            const verification = await verifyPageJsonAlongWithObject(invalidPage, pkc, community, undefined);
            expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
        });
        it(`comment.parentCid`, async () => {
            const invalidPage = remeda.clone(validPageIpfsFixture) as PageIpfs;
            const commentWithRepliesIndex = invalidPage.comments.findIndex(
                (pageComment) => pageComment.commentUpdate.replyCount > 0 && pageComment.commentUpdate.replies?.pages
            );
            expect(commentWithRepliesIndex).to.be.greaterThanOrEqual(0);
            const preloadedPageSortName = Object.keys(invalidPage.comments[commentWithRepliesIndex].commentUpdate.replies!.pages)[0];
            (
                invalidPage.comments[commentWithRepliesIndex].commentUpdate.replies!.pages[preloadedPageSortName] as PageIpfs
            ).comments[0].comment.parentCid += "123"; // Should invalidate page
            const verification = await verifyPageJsonAlongWithObject(invalidPage, pkc, community, undefined);
            expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
        });
        it(`comment.communityPublicKey`, async () => {
            const invalidPage = remeda.clone(validPageIpfsFixture) as PageIpfs;
            (invalidPage.comments[0].comment as Record<string, unknown>).communityPublicKey += "1234";
            const verification = await verifyPageJsonAlongWithObject(invalidPage, pkc, community, undefined);
            expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_COMMUNITY });
        });
        it(`comment.communityName`, async () => {
            const invalidPage = remeda.clone(validPageIpfsFixture) as PageIpfs;
            (invalidPage.comments[0].comment as Record<string, unknown>).communityName = "fake.eth";
            const verification = await verifyPageJsonAlongWithObject(invalidPage, pkc, community, undefined);
            expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_COMMUNITY });
        });
        it("comment.timestamp", async () => {
            const invalidPage = remeda.clone(validPageIpfsFixture) as PageIpfs;
            invalidPage.comments[0].comment.timestamp += 1;
            const verification = await verifyPageJsonAlongWithObject(invalidPage, pkc, community, undefined);
            expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
        });
        it(`comment.author.address (ed25519)`, async () => {
            const invalidPage = remeda.clone(validPageIpfsFixture) as PageIpfs;
            (invalidPage.comments[0].comment.author as { address: string }).address =
                "12D3KooWJJcSwMHrFvsFL7YCNDLD93kBczEfkHpPNdxcjZwR2X2Y"; // Random address
            const verification = await verifyPageJsonAlongWithObject(invalidPage, pkc, community, undefined);
            expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
        });
        it(`comment.author.previousCommentCid`, async () => {
            const invalidPage = remeda.clone(validPageIpfsFixture) as PageIpfs;
            invalidPage.comments[0].comment.author.previousCommentCid! += "1";
            const verification = await verifyPageJsonAlongWithObject(invalidPage, pkc, community, undefined);
            expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
        });
        it(`comment.author.displayName`, async () => {
            const invalidPage = remeda.clone(validPageIpfsFixture) as PageIpfs;
            invalidPage.comments[0].comment.author.displayName! += "1";
            const verification = await verifyPageJsonAlongWithObject(invalidPage, pkc, community, undefined);
            expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
        });
        it("comment.author.wallets", async () => {
            const invalidPage = remeda.clone(validPageIpfsFixture) as PageIpfs;
            const commentWithWalletsIndex = invalidPage.comments.findIndex((comment) => comment.comment.author.wallets);
            expect(commentWithWalletsIndex).to.be.greaterThanOrEqual(0);
            // Corrupt the wallets by converting to string (this is intentional to test signature validation)
            (invalidPage.comments[commentWithWalletsIndex].comment.author as { wallets: unknown }).wallets =
                String(invalidPage.comments[commentWithWalletsIndex].comment.author.wallets) + "12234";
            const verification = await verifyPageJsonAlongWithObject(invalidPage, pkc, community, undefined);
            expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
        });
        it("comment.author.avatar", async () => {
            const invalidPage = remeda.clone(validPageIpfsFixture) as PageIpfs;
            const commentWithAvatarIndex = invalidPage.comments.findIndex((comment) => comment.comment.author.avatar);
            expect(commentWithAvatarIndex).to.be.greaterThanOrEqual(0);
            invalidPage.comments[commentWithAvatarIndex].comment.author.avatar!.id += "12234";
            const verification = await verifyPageJsonAlongWithObject(invalidPage, pkc, community, undefined);
            expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
        });
    });
});

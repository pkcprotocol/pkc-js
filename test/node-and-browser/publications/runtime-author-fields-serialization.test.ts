import signers from "../../fixtures/signers.js";
import { getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { SignerWithPublicKeyAddress } from "../../../dist/node/signer/index.js";
import type { PageTypeJson } from "../../../dist/node/pages/types.js";

const communityAddress = signers[0].address;
const fakeCid = "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f";

function assertRuntimeAuthorFields(author: Record<string, unknown>, label: string) {
    expect(author.address, `${label}: author.address`).to.be.a("string").that.is.not.empty;
    expect(author.publicKey, `${label}: author.publicKey`).to.be.a("string").that.is.not.empty;
    expect(author.shortAddress, `${label}: author.shortAddress`).to.be.a("string").that.is.not.empty;
}

function assertRuntimeAuthorFieldsSurviveSpread(instance: { author: Record<string, unknown> }, label: string) {
    const spread = { ...instance };
    assertRuntimeAuthorFields(spread.author, `${label} spread`);
    expect(spread.author.address, `${label} spread: author.address matches`).to.equal(instance.author.address);
    expect(spread.author.publicKey, `${label} spread: author.publicKey matches`).to.equal(instance.author.publicKey);
    expect(spread.author.shortAddress, `${label} spread: author.shortAddress matches`).to.equal(instance.author.shortAddress);
}

function assertRuntimeAuthorFieldsSurviveStringify(instance: { author: Record<string, unknown> }, label: string) {
    const parsed = JSON.parse(JSON.stringify(instance));
    assertRuntimeAuthorFields(parsed.author, `${label} JSON.stringify`);
    expect(parsed.author.address, `${label} JSON.stringify: author.address matches`).to.equal(instance.author.address);
    expect(parsed.author.publicKey, `${label} JSON.stringify: author.publicKey matches`).to.equal(instance.author.publicKey);
    expect(parsed.author.shortAddress, `${label} JSON.stringify: author.shortAddress matches`).to.equal(instance.author.shortAddress);
}

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`Runtime author fields in spread and JSON.stringify - ${config.name}`, () => {
        let pkc: PKC;
        let signer: SignerWithPublicKeyAddress;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            signer = await pkc.createSigner();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        describe("Comment", () => {
            it("has runtime author fields", async () => {
                const comment = await pkc.createComment({
                    communityAddress: communityAddress,
                    signer,
                    content: "test content",
                    title: "test title"
                });
                assertRuntimeAuthorFields(comment.author, "Comment");
            });

            it("runtime author fields survive spread", async () => {
                const comment = await pkc.createComment({
                    communityAddress: communityAddress,
                    signer,
                    content: "test content",
                    title: "test title"
                });
                assertRuntimeAuthorFieldsSurviveSpread(comment, "Comment");
            });

            it("runtime author fields survive JSON.stringify", async () => {
                const comment = await pkc.createComment({
                    communityAddress: communityAddress,
                    signer,
                    content: "test content",
                    title: "test title"
                });
                assertRuntimeAuthorFieldsSurviveStringify(comment, "Comment");
            });
        });

        describe("Vote", () => {
            it("has runtime author fields", async () => {
                const vote = await pkc.createVote({
                    communityAddress: communityAddress,
                    signer,
                    commentCid: fakeCid,
                    vote: 1
                });
                assertRuntimeAuthorFields(vote.author, "Vote");
            });

            it("runtime author fields survive spread", async () => {
                const vote = await pkc.createVote({
                    communityAddress: communityAddress,
                    signer,
                    commentCid: fakeCid,
                    vote: 1
                });
                assertRuntimeAuthorFieldsSurviveSpread(vote, "Vote");
            });

            it("runtime author fields survive JSON.stringify", async () => {
                const vote = await pkc.createVote({
                    communityAddress: communityAddress,
                    signer,
                    commentCid: fakeCid,
                    vote: 1
                });
                assertRuntimeAuthorFieldsSurviveStringify(vote, "Vote");
            });
        });

        describe("CommentEdit", () => {
            it("has runtime author fields", async () => {
                const edit = await pkc.createCommentEdit({
                    communityAddress: communityAddress,
                    signer,
                    commentCid: fakeCid,
                    content: "edited content"
                });
                assertRuntimeAuthorFields(edit.author, "CommentEdit");
            });

            it("runtime author fields survive spread", async () => {
                const edit = await pkc.createCommentEdit({
                    communityAddress: communityAddress,
                    signer,
                    commentCid: fakeCid,
                    content: "edited content"
                });
                assertRuntimeAuthorFieldsSurviveSpread(edit, "CommentEdit");
            });

            it("runtime author fields survive JSON.stringify", async () => {
                const edit = await pkc.createCommentEdit({
                    communityAddress: communityAddress,
                    signer,
                    commentCid: fakeCid,
                    content: "edited content"
                });
                assertRuntimeAuthorFieldsSurviveStringify(edit, "CommentEdit");
            });
        });

        describe("CommentModeration", () => {
            it("has runtime author fields", async () => {
                const moderation = await pkc.createCommentModeration({
                    communityAddress: communityAddress,
                    signer,
                    commentCid: fakeCid,
                    commentModeration: { removed: true }
                });
                assertRuntimeAuthorFields(moderation.author, "CommentModeration");
            });

            it("runtime author fields survive spread", async () => {
                const moderation = await pkc.createCommentModeration({
                    communityAddress: communityAddress,
                    signer,
                    commentCid: fakeCid,
                    commentModeration: { removed: true }
                });
                assertRuntimeAuthorFieldsSurviveSpread(moderation, "CommentModeration");
            });

            it("runtime author fields survive JSON.stringify", async () => {
                const moderation = await pkc.createCommentModeration({
                    communityAddress: communityAddress,
                    signer,
                    commentCid: fakeCid,
                    commentModeration: { removed: true }
                });
                assertRuntimeAuthorFieldsSurviveStringify(moderation, "CommentModeration");
            });
        });

        describe("CommunityEdit", () => {
            it("has runtime author fields", async () => {
                const subEdit = await pkc.createCommunityEdit({
                    communityAddress: communityAddress,
                    signer,
                    communityEdit: { description: "new description" }
                });
                assertRuntimeAuthorFields(subEdit.author, "CommunityEdit");
            });

            it("runtime author fields survive spread", async () => {
                const subEdit = await pkc.createCommunityEdit({
                    communityAddress: communityAddress,
                    signer,
                    communityEdit: { description: "new description" }
                });
                assertRuntimeAuthorFieldsSurviveSpread(subEdit, "CommunityEdit");
            });

            it("runtime author fields survive JSON.stringify", async () => {
                const subEdit = await pkc.createCommunityEdit({
                    communityAddress: communityAddress,
                    signer,
                    communityEdit: { description: "new description" }
                });
                assertRuntimeAuthorFieldsSurviveStringify(subEdit, "CommunityEdit");
            });
        });

        describe("community.posts page comments", () => {
            it("page comments have runtime author fields that survive spread and JSON.stringify", async () => {
                const community = await pkc.getCommunity({ address: communityAddress });
                const pages = community.posts.pages || {};
                expect(Object.keys(pages).length, "community.posts.pages should not be empty").to.be.greaterThan(0);

                let testedComments = 0;

                for (const [pageName, page] of Object.entries(pages) as [string, PageTypeJson | undefined][]) {
                    if (!page?.comments?.length) continue;

                    for (const comment of page.comments) {
                        const label = `page ${pageName} comment ${comment.cid}`;
                        assertRuntimeAuthorFields(comment.author, label);
                        assertRuntimeAuthorFieldsSurviveSpread(comment as { author: Record<string, unknown> }, label);
                        assertRuntimeAuthorFieldsSurviveStringify(comment as { author: Record<string, unknown> }, label);
                        testedComments++;
                    }
                }

                expect(testedComments, "should have tested at least 1 page comment").to.be.greaterThan(0);
            });
        });
    });
});

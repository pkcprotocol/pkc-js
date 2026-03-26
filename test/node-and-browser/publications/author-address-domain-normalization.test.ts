import { beforeAll, afterAll, describe, it, expect } from "vitest";
import signers from "../../fixtures/signers.js";
import { getAvailablePlebbitConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";
import type { Plebbit } from "../../../dist/node/plebbit/plebbit.js";

const subplebbitAddress = signers[0].address;
const domainAddress = "plebbit.bso";
// Use a fake CID for publications that require commentCid (not publishing, just creating locally)
const fakeCid = "QmYHzA8euDgUpNy3fh7JGFnCEKVjjHGPMNUCbgnmc3cGRv";

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe(`author.address domain normalization - ${config.name}`, () => {
        let plebbit: Plebbit;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit?.destroy();
        });

        it("createComment copies author.address domain to author.name and excludes address from wire", async () => {
            const comment = await plebbit.createComment({
                communityAddress: subplebbitAddress,
                content: "test",
                title: "test",
                author: { address: domainAddress },
                signer: signers[3]
            });

            expect(comment.author.name).to.equal(domainAddress);
            expect(comment.author.address).to.equal(domainAddress);
            expect(comment.raw.pubsubMessageToPublish!.author).to.not.have.property("address");
            expect(comment.raw.pubsubMessageToPublish!.author!.name).to.equal(domainAddress);
        });

        it("createVote copies author.address domain to author.name and excludes address from wire", async () => {
            const vote = await plebbit.createVote({
                communityAddress: subplebbitAddress,
                commentCid: fakeCid,
                vote: 1,
                author: { address: domainAddress },
                signer: signers[3]
            });

            expect(vote.author.name).to.equal(domainAddress);
            expect(vote.author.address).to.equal(domainAddress);
            expect(vote.raw.pubsubMessageToPublish!.author).to.not.have.property("address");
            expect(vote.raw.pubsubMessageToPublish!.author!.name).to.equal(domainAddress);
        });

        it("createCommentEdit copies author.address domain to author.name and excludes address from wire", async () => {
            const edit = await plebbit.createCommentEdit({
                communityAddress: subplebbitAddress,
                commentCid: fakeCid,
                content: "edited",
                author: { address: domainAddress },
                signer: signers[3]
            });

            expect(edit.author.name).to.equal(domainAddress);
            expect(edit.author.address).to.equal(domainAddress);
            expect(edit.raw.pubsubMessageToPublish!.author).to.not.have.property("address");
            expect(edit.raw.pubsubMessageToPublish!.author!.name).to.equal(domainAddress);
        });

        it("createCommentModeration copies author.address domain to author.name and excludes address from wire", async () => {
            const mod = await plebbit.createCommentModeration({
                communityAddress: subplebbitAddress,
                commentCid: fakeCid,
                commentModeration: { removed: true },
                author: { address: domainAddress },
                signer: signers[3]
            });

            expect(mod.author.name).to.equal(domainAddress);
            expect(mod.author.address).to.equal(domainAddress);
            expect(mod.raw.pubsubMessageToPublish!.author).to.not.have.property("address");
            expect(mod.raw.pubsubMessageToPublish!.author!.name).to.equal(domainAddress);
        });

        it("createSubplebbitEdit copies author.address domain to author.name and excludes address from wire", async () => {
            const subEdit = await plebbit.createSubplebbitEdit({
                communityAddress: subplebbitAddress,
                subplebbitEdit: { title: "new title" },
                author: { address: domainAddress },
                signer: signers[3]
            });

            expect(subEdit.author.name).to.equal(domainAddress);
            expect(subEdit.author.address).to.equal(domainAddress);
            expect(subEdit.raw.pubsubMessageToPublish!.author).to.not.have.property("address");
            expect(subEdit.raw.pubsubMessageToPublish!.author!.name).to.equal(domainAddress);
        });

        it("createComment ignores non-domain author.address and derives address from signer", async () => {
            const comment = await plebbit.createComment({
                communityAddress: subplebbitAddress,
                content: "test",
                title: "test",
                author: { address: "bogusAddress123" },
                signer: signers[3]
            });

            expect(comment.author.address).to.equal(signers[3].address);
            expect(comment.author.name).to.be.undefined;
            const wireAuthor = comment.raw.pubsubMessageToPublish!.author;
            expect(wireAuthor === undefined || !("address" in wireAuthor)).to.be.true;
            expect(wireAuthor === undefined || !("name" in wireAuthor)).to.be.true;
        });

        it("createVote ignores non-domain author.address and derives address from signer", async () => {
            const vote = await plebbit.createVote({
                communityAddress: subplebbitAddress,
                commentCid: fakeCid,
                vote: 1,
                author: { address: "bogusAddress123" },
                signer: signers[3]
            });

            expect(vote.author.address).to.equal(signers[3].address);
            expect(vote.author.name).to.be.undefined;
            const wireAuthor = vote.raw.pubsubMessageToPublish!.author;
            expect(wireAuthor === undefined || !("address" in wireAuthor)).to.be.true;
            expect(wireAuthor === undefined || !("name" in wireAuthor)).to.be.true;
        });

        it("createCommentEdit ignores non-domain author.address and derives address from signer", async () => {
            const edit = await plebbit.createCommentEdit({
                communityAddress: subplebbitAddress,
                commentCid: fakeCid,
                content: "edited",
                author: { address: "bogusAddress123" },
                signer: signers[3]
            });

            expect(edit.author.address).to.equal(signers[3].address);
            expect(edit.author.name).to.be.undefined;
            const wireAuthor = edit.raw.pubsubMessageToPublish!.author;
            expect(wireAuthor === undefined || !("address" in wireAuthor)).to.be.true;
            expect(wireAuthor === undefined || !("name" in wireAuthor)).to.be.true;
        });

        it("createCommentModeration ignores non-domain author.address and derives address from signer", async () => {
            const mod = await plebbit.createCommentModeration({
                communityAddress: subplebbitAddress,
                commentCid: fakeCid,
                commentModeration: { removed: true },
                author: { address: "bogusAddress123" },
                signer: signers[3]
            });

            expect(mod.author.address).to.equal(signers[3].address);
            expect(mod.author.name).to.be.undefined;
            const wireAuthor = mod.raw.pubsubMessageToPublish!.author;
            expect(wireAuthor === undefined || !("address" in wireAuthor)).to.be.true;
            expect(wireAuthor === undefined || !("name" in wireAuthor)).to.be.true;
        });

        it("createSubplebbitEdit ignores non-domain author.address and derives address from signer", async () => {
            const subEdit = await plebbit.createSubplebbitEdit({
                communityAddress: subplebbitAddress,
                subplebbitEdit: { title: "new title" },
                author: { address: "bogusAddress123" },
                signer: signers[3]
            });

            expect(subEdit.author.address).to.equal(signers[3].address);
            expect(subEdit.author.name).to.be.undefined;
            const wireAuthor = subEdit.raw.pubsubMessageToPublish!.author;
            expect(wireAuthor === undefined || !("address" in wireAuthor)).to.be.true;
            expect(wireAuthor === undefined || !("name" in wireAuthor)).to.be.true;
        });

        it("createComment preserves existing author.name when author.address is also a domain", async () => {
            const comment = await plebbit.createComment({
                communityAddress: subplebbitAddress,
                content: "test",
                title: "test",
                author: { address: domainAddress, name: "custom.eth" },
                signer: signers[3]
            });

            // Existing name should NOT be overwritten
            expect(comment.author.name).to.equal("custom.eth");
            expect(comment.author.address).to.equal("custom.eth");
            expect(comment.raw.pubsubMessageToPublish!.author).to.not.have.property("address");
            expect(comment.raw.pubsubMessageToPublish!.author!.name).to.equal("custom.eth");
        });
    });
});

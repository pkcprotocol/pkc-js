import {
    getAvailablePlebbitConfigsToTestAgainst,
    publishRandomPost,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import signers from "../../../fixtures/signers.js";
import { describe, beforeAll, afterAll, it } from "vitest";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.concurrent(`comment.original - ${config.name}`, async () => {
        let plebbit: Plebbit;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`comment.original after publishing a comment successfully`, async () => {
            const post = await publishRandomPost({ subplebbitAddress: signers[0].address, plebbit: plebbit });
            expect(post.original.author.address).to.equal(post.author.address);
            expect(post.original.author.subplebbit).to.be.undefined;
            expect(post.original.content).to.equal(post.content);
            expect(post.original.protocolVersion).to.be.a("string");
            expect(post.original.signature).to.deep.equal(post.signature);
            expect(post.original.signature).to.include.all.keys("type", "signature", "publicKey", "signedPropertyNames");
        });

        it.sequential(`comment.original from plebbit.getComment({cid: ) should be undefined`, async () => {
            const sub = await plebbit.createSubplebbit({ address: signers[0].address });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => typeof sub.updatedAt === "number"
            });
            const cid = sub.posts.pages.hot.comments[0].cid;
            await sub.stop();
            const comment = await plebbit.getComment({ cid: cid });

            expect(comment.original).to.be.undefined;
        });

        it(`comment.original from comment.update() after CommentUpdate`, async () => {
            const originalComment = await publishRandomPost({ subplebbitAddress: signers[0].address, plebbit: plebbit });
            const cid = originalComment.cid;
            const comment = await plebbit.createComment({ cid });
            await comment.update();
            await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
            expect(comment.original.author.address).to.equal(originalComment.author.address);
            expect(comment.original.author.subplebbit).to.be.undefined;
            expect(comment.original.content).to.equal(originalComment.content);
            expect(comment.original.protocolVersion).to.be.a("string");
            expect(comment.original.signature).to.deep.equal(originalComment.signature);
            expect(comment.original.signature).to.include.all.keys("type", "signature", "publicKey", "signedPropertyNames");

            await comment.stop();
        });
    });
});

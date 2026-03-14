import { beforeAll, afterAll, describe, it } from "vitest";
import {
    publishRandomPost,
    createSubWithNoChallenge,
    resolveWhenConditionIsTrue,
    describeSkipIfRpc,
    mockCacheOfTextRecord,
    mockPlebbitV2
} from "../../../dist/node/test/test-util.js";
import { verifyCommentIpfs } from "../../../dist/node/signer/signatures.js";

import { v4 as uuidV4 } from "uuid";

import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

describeSkipIfRpc(`.eth <-> .bso alias equivalence`, async () => {
    let plebbit: PlebbitType;
    let remotePlebbit: PlebbitType;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let ethNameAddress: string;
    let bsoNameAddress: string;
    let postPublishedOnEth: Comment;

    beforeAll(async () => {
        plebbit = await mockPlebbitV2({ stubStorage: false, mockResolve: true });
        remotePlebbit = await mockPlebbitV2({ stubStorage: false, mockResolve: true, remotePlebbit: true });

        subplebbit = await createSubWithNoChallenge({}, plebbit);
        const domainBase = `test-equiv-${uuidV4()}`;
        ethNameAddress = `${domainBase}.eth`;
        bsoNameAddress = `${domainBase}.bso`;

        // Mock both .eth and .bso domains to resolve to the same signer address
        for (const domain of [ethNameAddress, bsoNameAddress]) {
            await mockCacheOfTextRecord({
                plebbit,
                domain,
                resolveType: "community",
                value: subplebbit.signer.address
            });
            await mockCacheOfTextRecord({
                plebbit: remotePlebbit,
                domain,
                resolveType: "community",
                value: subplebbit.signer.address
            });
        }

        // Start with .eth domain, publish a post, then transition to .bso
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
        await subplebbit.edit({ address: ethNameAddress });
        await new Promise((resolve) => subplebbit.once("update", resolve));
        expect(subplebbit.address).to.equal(ethNameAddress);

        // Publish a post under the .eth address
        postPublishedOnEth = await publishRandomPost({ subplebbitAddress: ethNameAddress, plebbit: plebbit });
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () =>
                Boolean(subplebbit?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postPublishedOnEth.cid))
        });

        // Transition to .bso
        await subplebbit.edit({ address: bsoNameAddress });
        await new Promise((resolve) => subplebbit.once("update", resolve));
        expect(subplebbit.address).to.equal(bsoNameAddress);

        // Wait for pages to be regenerated with the post still included
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () =>
                Boolean(subplebbit?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postPublishedOnEth.cid))
        });
    });

    afterAll(async () => {
        await subplebbit.stop();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    describe(`verifyCommentIpfs with cross-alias subplebbitAddress`, () => {
        it(`accepts comment with .eth subplebbitAddress in a .bso subplebbit`, async () => {
            const pageComment = subplebbit.posts.pages.hot!.comments.find((c) => c.cid === postPublishedOnEth.cid)!;
            expect(pageComment).to.not.be.undefined;
            expect(pageComment.subplebbitAddress).to.equal(ethNameAddress);

            const verification = await verifyCommentIpfs({
                comment: pageComment.raw.comment,
                clientsManager: plebbit._clientsManager,
                resolveAuthorNames: false,
                calculatedCommentCid: pageComment.cid!,
                subplebbitAddressFromInstance: bsoNameAddress
            });
            expect(verification.valid).to.be.true;
        });

        it(`accepts comment with .bso subplebbitAddress in a .eth subplebbit`, async () => {
            const pageComment = subplebbit.posts.pages.hot!.comments[0];
            expect(pageComment).to.not.be.undefined;

            const verification = await verifyCommentIpfs({
                comment: pageComment.raw.comment,
                clientsManager: plebbit._clientsManager,
                resolveAuthorNames: false,
                calculatedCommentCid: pageComment.cid!,
                subplebbitAddressFromInstance: pageComment.subplebbitAddress.endsWith(".eth")
                    ? pageComment.subplebbitAddress.slice(0, -4) + ".bso"
                    : pageComment.subplebbitAddress.slice(0, -4) + ".eth"
            });
            expect(verification.valid).to.be.true;
        });
    });

    describe(`createComment with cross-alias subplebbitAddress`, () => {
        it(`createComment({cid, subplebbitAddress: ".bso"}) works when comment was published under .eth`, async () => {
            const comment = await remotePlebbit.createComment({ cid: postPublishedOnEth.cid!, subplebbitAddress: bsoNameAddress });
            await comment.update();
            await resolveWhenConditionIsTrue({
                toUpdate: comment,
                predicate: async () => typeof comment.updatedAt === "number"
            });
            await comment.stop();
            expect(comment.raw.comment!.subplebbitAddress).to.equal(ethNameAddress);
            expect(comment.cid).to.equal(postPublishedOnEth.cid);
            expect(comment.updatedAt).to.be.a("number");
        });

        it(`createComment({cid, subplebbitAddress: ".eth"}) works when comment was published under .bso`, async () => {
            expect(subplebbit.address).to.equal(bsoNameAddress);
            const postOnBso = await publishRandomPost({ subplebbitAddress: bsoNameAddress, plebbit: plebbit });
            await resolveWhenConditionIsTrue({
                toUpdate: subplebbit,
                predicate: async () => Boolean(subplebbit?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postOnBso.cid))
            });

            const comment = await remotePlebbit.createComment({ cid: postOnBso.cid!, subplebbitAddress: ethNameAddress });
            await comment.update();
            await resolveWhenConditionIsTrue({
                toUpdate: comment,
                predicate: async () => typeof comment.updatedAt === "number"
            });
            await comment.stop();
            expect(comment.raw.comment!.subplebbitAddress).to.equal(bsoNameAddress);
            expect(comment.cid).to.equal(postOnBso.cid);
            expect(comment.updatedAt).to.be.a("number");
        });
    });

    describe(`getComment with cross-alias comments`, () => {
        it(`getComment(cid) works for a comment published under .eth (before transition to .bso)`, async () => {
            const comment = await remotePlebbit.getComment({ cid: postPublishedOnEth.cid! });
            expect(comment.raw.comment!.subplebbitAddress).to.equal(ethNameAddress);
            expect(comment.cid).to.equal(postPublishedOnEth.cid);
            expect(comment.content).to.be.a("string");
        });

        it(`getComment(cid) works for a comment published under .bso (after transition from .eth)`, async () => {
            expect(subplebbit.address).to.equal(bsoNameAddress);
            const bsoPost = subplebbit.posts!.pages.hot!.comments!.find((c) => c.raw.comment!.subplebbitAddress === bsoNameAddress);
            expect(bsoPost).to.not.be.undefined;

            const comment = await remotePlebbit.getComment({ cid: bsoPost!.cid! });
            expect(comment.raw.comment!.subplebbitAddress).to.equal(bsoNameAddress);
            expect(comment.cid).to.equal(bsoPost!.cid);
            expect(comment.content).to.be.a("string");
        });
    });
});

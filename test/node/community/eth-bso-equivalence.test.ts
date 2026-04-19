import { beforeAll, afterAll, describe, it } from "vitest";
import {
    createMockNameResolver,
    publishRandomPost,
    createSubWithNoChallenge,
    resolveWhenConditionIsTrue,
    mockPKCV2
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { verifyCommentIpfs } from "../../../dist/node/signer/signatures.js";

import { v4 as uuidV4 } from "uuid";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

describeSkipIfRpc(`.eth <-> .bso alias equivalence`, async () => {
    let pkc: PKCType;
    let remotePKC: PKCType;
    let community: LocalCommunity | RpcLocalCommunity;
    let ethNameAddress: string;
    let bsoNameAddress: string;
    let postPublishedOnEth: Comment;
    let pkcResolverRecords: Map<string, string | undefined>;
    let remoteResolverRecords: Map<string, string | undefined>;

    beforeAll(async () => {
        pkcResolverRecords = new Map();
        remoteResolverRecords = new Map();
        pkc = await mockPKCV2({
            stubStorage: false,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: pkcResolverRecords })]
            }
        });
        remotePKC = await mockPKCV2({
            stubStorage: false,
            mockResolve: false,
            remotePKC: true,
            pkcOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: remoteResolverRecords })]
            }
        });

        community = await createSubWithNoChallenge({}, pkc);
        const domainBase = `test-equiv-${uuidV4()}`;
        ethNameAddress = `${domainBase}.eth`;
        bsoNameAddress = `${domainBase}.bso`;

        // Mock both .eth and .bso domains to resolve to the same signer address
        for (const domain of [ethNameAddress, bsoNameAddress]) {
            pkcResolverRecords.set(domain, community.signer.address);
            remoteResolverRecords.set(domain, community.signer.address);
        }

        // Start with .eth domain, publish a post, then transition to .bso
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await community.edit({ address: ethNameAddress });
        await new Promise((resolve) => community.once("update", resolve));
        expect(community.address).to.equal(ethNameAddress);

        // Publish a post under the .eth address
        postPublishedOnEth = await publishRandomPost({ communityAddress: ethNameAddress, pkc: pkc });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () =>
                Boolean(community?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postPublishedOnEth.cid))
        });

        // Transition to .bso
        await community.edit({ address: bsoNameAddress });
        await new Promise((resolve) => community.once("update", resolve));
        expect(community.address).to.equal(bsoNameAddress);

        // Wait for pages to be regenerated with the post still included
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () =>
                Boolean(community?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postPublishedOnEth.cid))
        });
    });

    afterAll(async () => {
        await community.stop();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    describe(`verifyCommentIpfs with cross-alias communityAddress`, () => {
        it(`accepts comment with .eth communityAddress in a .bso community`, async () => {
            const pageComment = community.posts.pages.hot!.comments.find((c) => c.cid === postPublishedOnEth.cid)!;
            expect(pageComment).to.not.be.undefined;
            expect(pageComment.communityAddress).to.equal(ethNameAddress);

            const verification = await verifyCommentIpfs({
                comment: pageComment.raw.comment,
                clientsManager: pkc._clientsManager,
                resolveAuthorNames: false,
                calculatedCommentCid: pageComment.cid!,
                communityNameFromInstance: bsoNameAddress
            });
            expect(verification.valid).to.be.true;
        });

        it(`accepts comment with .bso communityAddress in a .eth community`, async () => {
            const pageComment = community.posts.pages.hot!.comments[0];
            expect(pageComment).to.not.be.undefined;

            const verification = await verifyCommentIpfs({
                comment: pageComment.raw.comment,
                clientsManager: pkc._clientsManager,
                resolveAuthorNames: false,
                calculatedCommentCid: pageComment.cid!,
                communityNameFromInstance: pageComment.communityAddress.endsWith(".eth")
                    ? pageComment.communityAddress.slice(0, -4) + ".bso"
                    : pageComment.communityAddress.slice(0, -4) + ".eth"
            });
            expect(verification.valid).to.be.true;
        });
    });

    describe(`createComment with cross-alias communityAddress`, () => {
        it(`createComment({cid, communityAddress: ".bso"}) works when comment was published under .eth`, async () => {
            const comment = await remotePKC.createComment({ cid: postPublishedOnEth.cid!, communityAddress: bsoNameAddress });
            await comment.update();
            await resolveWhenConditionIsTrue({
                toUpdate: comment,
                predicate: async () => typeof comment.updatedAt === "number"
            });
            await comment.stop();
            expect(comment.communityAddress).to.equal(ethNameAddress);
            expect(comment.cid).to.equal(postPublishedOnEth.cid);
            expect(comment.updatedAt).to.be.a("number");
        });

        it(`createComment({cid, communityAddress: ".eth"}) works when comment was published under .bso`, async () => {
            expect(community.address).to.equal(bsoNameAddress);
            const postOnBso = await publishRandomPost({ communityAddress: bsoNameAddress, pkc: pkc });
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => Boolean(community?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postOnBso.cid))
            });

            const comment = await remotePKC.createComment({ cid: postOnBso.cid!, communityAddress: ethNameAddress });
            await comment.update();
            await resolveWhenConditionIsTrue({
                toUpdate: comment,
                predicate: async () => typeof comment.updatedAt === "number"
            });
            await comment.stop();
            expect(comment.communityAddress).to.equal(bsoNameAddress);
            expect(comment.cid).to.equal(postOnBso.cid);
            expect(comment.updatedAt).to.be.a("number");
        });
    });

    describe(`getComment with cross-alias comments`, () => {
        it(`getComment(cid) works for a comment published under .eth (before transition to .bso)`, async () => {
            const comment = await remotePKC.getComment({ cid: postPublishedOnEth.cid! });
            expect(comment.communityAddress).to.equal(ethNameAddress);
            expect(comment.cid).to.equal(postPublishedOnEth.cid);
            expect(comment.content).to.be.a("string");
        });

        it(`getComment(cid) works for a comment published under .bso (after transition from .eth)`, async () => {
            expect(community.address).to.equal(bsoNameAddress);
            const bsoPost = community.posts!.pages.hot!.comments!.find((c) => c.communityAddress === bsoNameAddress);
            expect(bsoPost).to.not.be.undefined;

            const comment = await remotePKC.getComment({ cid: bsoPost!.cid! });
            expect(comment.communityAddress).to.equal(bsoNameAddress);
            expect(comment.cid).to.equal(bsoPost!.cid);
            expect(comment.content).to.be.a("string");
        });
    });
});

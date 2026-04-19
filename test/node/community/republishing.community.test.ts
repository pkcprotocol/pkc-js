import { beforeAll, afterAll, it } from "vitest";
import {
    mockPKC,
    publishRandomPost,
    createSubWithNoChallenge,
    publishRandomReply,
    setExtraPropOnCommentAndSign,
    generateMockPost,
    waitTillReplyInParentPages,
    publishWithExpectedResult,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    waitTillPostInCommunityPages,
    iterateThroughPagesToFindCommentInParentPagesInstance
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";
import type { CreateNewLocalCommunityUserOptions } from "../../../dist/node/community/types.js";

// This test file will be focused on republishing of comments/community/commentupdate/pages to the network
// if the ipfs repo is lost, the community should re-publish everything again
// Part of that is re-constructing commentIpfs which is something will we will be testing for

describeSkipIfRpc(`Migration to a new IPFS repo`, async () => {
    let subBeforeMigration: LocalCommunity | RpcLocalCommunity;
    let subAfterMigration: LocalCommunity | RpcLocalCommunity;
    let pkcDifferentIpfs: PKCType;
    let remotePKC: PKCType;
    let postWithExtraProps: Comment;
    beforeAll(async () => {
        const pkc = await mockPKC();
        subBeforeMigration = await createSubWithNoChallenge({}, pkc);
        await subBeforeMigration.start();
        await resolveWhenConditionIsTrue({
            toUpdate: subBeforeMigration,
            predicate: async () => typeof subBeforeMigration.updatedAt === "number"
        });
        const post = await publishRandomPost({ communityAddress: subBeforeMigration.address, pkc: pkc });
        await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, pkc: pkc });
        // publish a post with extra prop here
        postWithExtraProps = await generateMockPost({ communityAddress: subBeforeMigration.address, pkc: pkc });
        const extraProps = { extraProp: "1234" };
        await setExtraPropOnCommentAndSign(postWithExtraProps, extraProps, true);

        await publishWithExpectedResult({ publication: postWithExtraProps, expectedChallengeSuccess: true });
        const replyOfPostWithExtraProps = await publishRandomReply({
            parentComment: postWithExtraProps as CommentIpfsWithCidDefined,
            pkc: pkc
        });

        await subBeforeMigration.stop();

        pkcDifferentIpfs = await mockPKC({ kuboRpcClientsOptions: ["http://localhost:15004/api/v0"] }); // Different IPFS repo

        subAfterMigration = await createSubWithNoChallenge(
            { address: subBeforeMigration.address } as CreateNewLocalCommunityUserOptions,
            pkcDifferentIpfs
        );
        expect(subAfterMigration.updatedAt).to.equal(subBeforeMigration.updatedAt);
        await subAfterMigration.start(); // should migrate everything here
        await resolveWhenConditionIsTrue({
            toUpdate: subAfterMigration,
            predicate: async () => subAfterMigration.updatedAt! > subBeforeMigration.updatedAt!
        });

        expect(subAfterMigration.lastPostCid).to.equal(postWithExtraProps.cid);
        expect(subAfterMigration.lastCommentCid).to.equal(replyOfPostWithExtraProps.cid);

        // remote pkc has to be the same repo otherwise it won't find the new IPNS record
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient({
            pkcOptions: { kuboRpcClientsOptions: ["http://localhost:15004/api/v0"] }
        });
        // remote pkc is connected to the old ipfs repo and has the old IPNS record, not sure how to force it to load the new one

        const remoteCommunity = await remotePKC.getCommunity({ address: subAfterMigration.address });
        expect(remoteCommunity.lastPostCid).to.equal(postWithExtraProps.cid);
        expect(remoteCommunity.lastCommentCid).to.equal(replyOfPostWithExtraProps.cid);
        await waitTillPostInCommunityPages(postWithExtraProps as Comment & { cid: string }, remotePKC);
        await waitTillReplyInParentPages(replyOfPostWithExtraProps as Comment & { cid: string; parentCid: string }, remotePKC);
    });

    afterAll(async () => {
        await subAfterMigration.delete();
        await pkcDifferentIpfs.destroy();
        await remotePKC.destroy();
    });

    it(`Community IPNS is republished`, async () => {
        const subLoaded = await remotePKC.getCommunity({ address: subAfterMigration.address });
        expect(subLoaded).to.be.a("object");
        expect(subLoaded.posts).to.be.a("object");
        // If we can load the community IPNS that means it has been republished by the new IPFS repo
    });

    it(`Posts' IPFS are repinned`, async () => {
        const subLoaded = await remotePKC.getCommunity({ address: subAfterMigration.address });
        const postFromPage = subLoaded.posts.pages.hot!.comments[0];
        const postIpfs = JSON.parse((await remotePKC.fetchCid({ cid: postFromPage.cid })).content);
        // communityAddress is runtime-only; wire format uses communityPublicKey/communityName
        expect(postIpfs.communityPublicKey).to.equal(subAfterMigration.address); // Make sure it was loaded correctly
    });

    it(`Post with extra prop can be fetched from its cid`, async () => {
        const loadedPost = await remotePKC.getComment({ cid: postWithExtraProps.cid! });
        expect((loadedPost as Comment & { extraProp?: string }).extraProp).to.equal("1234");
    });

    it(`Post with extra prop retains its extra prop in pages`, async () => {
        const loadedCommunity = await remotePKC.createCommunity({ address: postWithExtraProps.communityAddress });
        await loadedCommunity.update();
        await resolveWhenConditionIsTrue({
            toUpdate: loadedCommunity,
            predicate: async () => {
                const loadedPost = await iterateThroughPagesToFindCommentInParentPagesInstance(
                    postWithExtraProps.cid!,
                    loadedCommunity.posts
                );
                return (loadedPost as { extraProp?: string } | undefined)?.extraProp === "1234";
            }
        });
        const loadedPost = await iterateThroughPagesToFindCommentInParentPagesInstance(postWithExtraProps.cid!, loadedCommunity.posts);
        expect((loadedPost as { extraProp?: string } | undefined)?.extraProp).to.equal("1234");
        await loadedCommunity.stop();
    });

    it(`Comments' IPFS are repinned`, async () => {
        const subLoaded = await remotePKC.getCommunity({ address: subAfterMigration.address });
        const postFromPage = subLoaded.posts.pages.hot!.comments[0];
        const commentIpfs = JSON.parse((await remotePKC.fetchCid({ cid: postFromPage.replies!.pages.best!.comments[0].cid })).content);
        // communityAddress is runtime-only; wire format uses communityPublicKey/communityName
        expect(commentIpfs.communityPublicKey).to.equal(subAfterMigration.address); // Make sure it was loaded correctly
    });
    it(`Comments' CommentUpdate are republished`, async () => {
        const subLoaded = await remotePKC.getCommunity({ address: subAfterMigration.address });
        const postFromPage = subLoaded.posts.pages.hot!.comments[0];

        const postWithRemotePKC = await remotePKC.createComment({ cid: postFromPage.cid });
        postWithRemotePKC.update();
        await new Promise((resolve) => postWithRemotePKC.once("update", resolve)); // CommentIpfs update
        expect(postWithRemotePKC.replyCount).to.be.undefined;
        await new Promise((resolve) => postWithRemotePKC.once("update", resolve)); // CommentUpdate update
        expect(postWithRemotePKC.replyCount).to.be.a("number");
        expect(postWithRemotePKC.upvoteCount).to.be.a("number");
        await postWithRemotePKC.stop();
    });
});

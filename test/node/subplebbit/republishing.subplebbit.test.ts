import { beforeAll, afterAll, it } from "vitest";
import {
    mockPlebbit,
    publishRandomPost,
    createSubWithNoChallenge,
    publishRandomReply,
    setExtraPropOnCommentAndSign,
    generateMockPost,
    waitTillReplyInParentPages,
    publishWithExpectedResult,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    describeSkipIfRpc,
    resolveWhenConditionIsTrue,
    waitTillPostInSubplebbitPages,
    iterateThroughPagesToFindCommentInParentPagesInstance
} from "../../../dist/node/test/test-util.js";

import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";
import type { CreateNewLocalSubplebbitUserOptions } from "../../../dist/node/subplebbit/types.js";

// This test file will be focused on republishing of comments/subplebbit/commentupdate/pages to the network
// if the ipfs repo is lost, the sub should re-publish everything again
// Part of that is re-constructing commentIpfs which is something will we will be testing for

describeSkipIfRpc(`Migration to a new IPFS repo`, async () => {
    let subBeforeMigration: LocalSubplebbit | RpcLocalSubplebbit;
    let subAfterMigration: LocalSubplebbit | RpcLocalSubplebbit;
    let plebbitDifferentIpfs: PlebbitType;
    let remotePlebbit: PlebbitType;
    let postWithExtraProps: Comment;
    beforeAll(async () => {
        const plebbit = await mockPlebbit();
        subBeforeMigration = await createSubWithNoChallenge({}, plebbit);
        await subBeforeMigration.start();
        await resolveWhenConditionIsTrue({
            toUpdate: subBeforeMigration,
            predicate: async () => typeof subBeforeMigration.updatedAt === "number"
        });
        const post = await publishRandomPost({ communityAddress: subBeforeMigration.address, plebbit: plebbit });
        await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, plebbit: plebbit });
        // publish a post with extra prop here
        postWithExtraProps = await generateMockPost({ communityAddress: subBeforeMigration.address, plebbit: plebbit });
        const extraProps = { extraProp: "1234" };
        await setExtraPropOnCommentAndSign(postWithExtraProps, extraProps, true);

        await publishWithExpectedResult({ publication: postWithExtraProps, expectedChallengeSuccess: true });
        const replyOfPostWithExtraProps = await publishRandomReply({
            parentComment: postWithExtraProps as CommentIpfsWithCidDefined,
            plebbit: plebbit
        });

        await subBeforeMigration.stop();

        plebbitDifferentIpfs = await mockPlebbit({ kuboRpcClientsOptions: ["http://localhost:15004/api/v0"] }); // Different IPFS repo

        subAfterMigration = await createSubWithNoChallenge(
            { address: subBeforeMigration.address } as CreateNewLocalSubplebbitUserOptions,
            plebbitDifferentIpfs
        );
        expect(subAfterMigration.updatedAt).to.equal(subBeforeMigration.updatedAt);
        await subAfterMigration.start(); // should migrate everything here
        await resolveWhenConditionIsTrue({
            toUpdate: subAfterMigration,
            predicate: async () => subAfterMigration.updatedAt! > subBeforeMigration.updatedAt!
        });

        expect(subAfterMigration.lastPostCid).to.equal(postWithExtraProps.cid);
        expect(subAfterMigration.lastCommentCid).to.equal(replyOfPostWithExtraProps.cid);

        // remote plebbit has to be the same repo otherwise it won't find the new IPNS record
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient({
            plebbitOptions: { kuboRpcClientsOptions: ["http://localhost:15004/api/v0"] }
        });
        // remote plebbit is connected to the old ipfs repo and has the old IPNS record, not sure how to force it to load the new one

        const remoteSubplebbit = await remotePlebbit.getSubplebbit({ address: subAfterMigration.address });
        expect(remoteSubplebbit.lastPostCid).to.equal(postWithExtraProps.cid);
        expect(remoteSubplebbit.lastCommentCid).to.equal(replyOfPostWithExtraProps.cid);
        await waitTillPostInSubplebbitPages(postWithExtraProps as Comment & { cid: string }, remotePlebbit);
        await waitTillReplyInParentPages(replyOfPostWithExtraProps as Comment & { cid: string; parentCid: string }, remotePlebbit);
    });

    afterAll(async () => {
        await subAfterMigration.delete();
        await plebbitDifferentIpfs.destroy();
        await remotePlebbit.destroy();
    });

    it(`Subplebbit IPNS is republished`, async () => {
        const subLoaded = await remotePlebbit.getSubplebbit({ address: subAfterMigration.address });
        expect(subLoaded).to.be.a("object");
        expect(subLoaded.posts).to.be.a("object");
        // If we can load the subplebbit IPNS that means it has been republished by the new IPFS repo
    });

    it(`Posts' IPFS are repinned`, async () => {
        const subLoaded = await remotePlebbit.getSubplebbit({ address: subAfterMigration.address });
        const postFromPage = subLoaded.posts.pages.hot!.comments[0];
        const postIpfs = JSON.parse(await remotePlebbit.fetchCid({ cid: postFromPage.cid }));
        // communityAddress is runtime-only; wire format uses communityPublicKey/communityName
        expect(postIpfs.communityPublicKey).to.equal(subAfterMigration.address); // Make sure it was loaded correctly
    });

    it(`Post with extra prop can be fetched from its cid`, async () => {
        const loadedPost = await remotePlebbit.getComment({ cid: postWithExtraProps.cid! });
        expect((loadedPost as Comment & { extraProp?: string }).extraProp).to.equal("1234");
    });

    it(`Post with extra prop retains its extra prop in pages`, async () => {
        const loadedSub = await remotePlebbit.createSubplebbit({ address: postWithExtraProps.communityAddress });
        await loadedSub.update();
        await resolveWhenConditionIsTrue({
            toUpdate: loadedSub,
            predicate: async () => {
                const loadedPost = await iterateThroughPagesToFindCommentInParentPagesInstance(postWithExtraProps.cid!, loadedSub.posts);
                return (loadedPost as { extraProp?: string } | undefined)?.extraProp === "1234";
            }
        });
        const loadedPost = await iterateThroughPagesToFindCommentInParentPagesInstance(postWithExtraProps.cid!, loadedSub.posts);
        expect((loadedPost as { extraProp?: string } | undefined)?.extraProp).to.equal("1234");
        await loadedSub.stop();
    });

    it(`Comments' IPFS are repinned`, async () => {
        const subLoaded = await remotePlebbit.getSubplebbit({ address: subAfterMigration.address });
        const postFromPage = subLoaded.posts.pages.hot!.comments[0];
        const commentIpfs = JSON.parse(await remotePlebbit.fetchCid({ cid: postFromPage.replies!.pages.best!.comments[0].cid }));
        // communityAddress is runtime-only; wire format uses communityPublicKey/communityName
        expect(commentIpfs.communityPublicKey).to.equal(subAfterMigration.address); // Make sure it was loaded correctly
    });
    it(`Comments' CommentUpdate are republished`, async () => {
        const subLoaded = await remotePlebbit.getSubplebbit({ address: subAfterMigration.address });
        const postFromPage = subLoaded.posts.pages.hot!.comments[0];

        const postWithRemotePlebbit = await remotePlebbit.createComment({ cid: postFromPage.cid });
        postWithRemotePlebbit.update();
        await new Promise((resolve) => postWithRemotePlebbit.once("update", resolve)); // CommentIpfs update
        expect(postWithRemotePlebbit.replyCount).to.be.undefined;
        await new Promise((resolve) => postWithRemotePlebbit.once("update", resolve)); // CommentUpdate update
        expect(postWithRemotePlebbit.replyCount).to.be.a("number");
        expect(postWithRemotePlebbit.upvoteCount).to.be.a("number");
        await postWithRemotePlebbit.stop();
    });
});

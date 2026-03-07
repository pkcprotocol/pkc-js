import {
    mockPlebbit,
    publishRandomPost,
    createSubWithNoChallenge,
    publishRandomReply,
    describeSkipIfRpc,
    mockCommentToNotUsePagesForUpdates,
    resolveWhenConditionIsTrue,
    waitTillPostInSubplebbitPages,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    forceLocalSubPagesToAlwaysGenerateMultipleChunks,
    publishCommentWithDepth
} from "../../../dist/node/test/test-util.js";
import Logger from "@plebbit/plebbit-logger";
import { describe, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

import type { Plebbit } from "../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";

const depthsToTest = [1, 2, 3, 5, 15, 30];

describeSkipIfRpc("subplebbit.postUpdates", async () => {
    let plebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let remotePlebbit: Plebbit;
    const replyCidByDepth: Record<number, string> = {};

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        subplebbit.setMaxListeners(200);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
    });

    beforeEach(async () => {
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
    });
    afterEach(async () => {
        await remotePlebbit.destroy();
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        for (const depth of Object.keys(replyCidByDepth)) delete replyCidByDepth[Number(depth)];
    });

    it(`subplebbit.postUpdates is undefined if there are no comments`, async () => {
        expect(subplebbit.postUpdates).to.be.undefined;
    });

    it(`subplebbit.postUpdates = {86400} when a post is published`, async () => {
        const post = await publishRandomPost({ subplebbitAddress: subplebbit.address, plebbit: remotePlebbit });
        await waitTillPostInSubplebbitPages(post as CommentIpfsWithCidDefined, remotePlebbit);

        const postRecreated = await remotePlebbit.createComment({ cid: post.cid });
        await postRecreated.update();
        mockCommentToNotUsePagesForUpdates(postRecreated);

        await resolveWhenConditionIsTrue({ toUpdate: postRecreated, predicate: async () => typeof postRecreated.updatedAt === "number" });
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => Boolean(subplebbit.postUpdates) });

        expect(postRecreated._commentUpdateIpfsPath?.endsWith("/update")).to.be.true; // should fetch from post updates directory
        expect(postRecreated.updatedAt).to.be.a("number"); // check for commentUpdate props
        expect(postRecreated.content).to.be.a("string"); // check for CommentIpfs props
        expect(subplebbit.postUpdates).to.exist;
        expect(Object.keys(subplebbit.postUpdates!)).to.deep.equal(["86400"]);
        await postRecreated.stop();
    });

    depthsToTest.map((depth) => {
        it(`Can publish a reply with depth = ${depth} to a post and fetch updates from its post's pages`, async () => {
            const log = Logger("plebbit-js:test:subplebbit:postUpdates:publishReplyWithDepth");

            // is it possibly only failing when reply is fetched using pages?
            const parentCommentInstance = await publishCommentWithDepth({ depth: depth - 1, subplebbit });

            await parentCommentInstance.update();
            await resolveWhenConditionIsTrue({
                toUpdate: parentCommentInstance,
                predicate: async () => typeof parentCommentInstance.updatedAt === "number"
            });

            await parentCommentInstance.stop(); // seems like this line fixes the flakiness

            const reply = await publishRandomReply({
                parentComment: parentCommentInstance as CommentIpfsWithCidDefined,
                plebbit: remotePlebbit
            });
            const { cleanup } = await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
                subplebbit,
                parentComment: parentCommentInstance
            });

            log("Published reply under comment", parentCommentInstance.cid, "with cid", reply.cid, "and depth", reply.depth);
            expect(reply.depth).to.equal(depth);
            replyCidByDepth[depth] = reply.cid!;

            // is it possible that local subplebbit is publishing a parent comment with outdated pageCids
            // maybe we should have a setInterval printing pageCids of parent comment, with local plebbit

            log("Creating and updating reply", reply.cid, "and depth", reply.depth);
            const replyRecreated = await remotePlebbit.createComment({ cid: reply.cid });

            await replyRecreated.update();

            await resolveWhenConditionIsTrue({
                toUpdate: replyRecreated,
                predicate: async () => typeof replyRecreated.updatedAt === "number"
            });

            expect(replyRecreated._commentUpdateIpfsPath).to.be.undefined; // should be undefined for replies since we're not including them in post updates
            expect(replyRecreated.updatedAt).to.be.a("number"); // check for commentUpdate props
            expect(replyRecreated.content).to.be.a("string"); // check for CommentIpfs props

            // Access private properties for testing
            const replyPrivate = replyRecreated as never as Record<string, { _updatingComments: Record<string, Comment> }>;
            const updatingReply = replyPrivate._plebbit._updatingComments[replyRecreated.cid!];
            const updatingReplyPrivate = updatingReply as never as Record<string, { _parentFirstPageCidsAlreadyLoaded: Set<string> }>;
            expect(updatingReplyPrivate._clientsManager._parentFirstPageCidsAlreadyLoaded.size).to.be.greaterThan(0);

            expect(Object.keys(subplebbit.postUpdates!)).to.deep.equal(["86400"]);

            await replyRecreated.stop();
            await parentCommentInstance.stop();
            await cleanup();
        });
    });

    it(`subplebbit.postUpdates moves posts from bucket to more accurate bucket`, async () => {
        // For example, we have a bucket 86400 which is for the last 24 hours,
        // But if we have a new bucket, 43200 for the last 12 hours, the post from previous tests should be moved to it
        const subPrivate = subplebbit as never as Record<string, number[]>;
        const currentBuckets = subPrivate._postUpdatesBuckets;
        subPrivate._postUpdatesBuckets = [43200, ...currentBuckets];
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () =>
                Object.keys(subplebbit.postUpdates || {}).length === 1 && Object.keys(subplebbit.postUpdates!)[0] === "43200"
        });
        expect(Object.keys(subplebbit.postUpdates!)).to.deep.equal(["43200"]);
    });

    it(`Can fetch post updates with new bucket`, async () => {
        const postCid = subplebbit.posts.pages.hot!.comments[0].cid;
        const post = await remotePlebbit.createComment({ cid: postCid });
        await post.update();
        mockCommentToNotUsePagesForUpdates(post);

        await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => typeof post.updatedAt === "number" });
        expect(post.content).to.be.a("string"); // comment ipfs has been loaded
        expect(post.updatedAt).to.be.a("number"); // comment update has been loaded

        expect(post._commentUpdateIpfsPath).to.be.a("string");
        expect(post._commentUpdateIpfsPath?.endsWith("/update")).to.be.true; // should fetch from post updates directory

        await post.stop();
    });

    depthsToTest.map((depth) => {
        it(`Can fetch updates from reply with depth = ${depth} with new bucket`, async () => {
            const replyCid = replyCidByDepth[depth];

            // Create and update the reply comment
            expect(replyCid).to.be.a("string");
            const reply = await remotePlebbit.createComment({ cid: replyCid });
            await reply.update();

            // Wait for CommentIpfs update
            await resolveWhenConditionIsTrue({ toUpdate: reply, predicate: async () => typeof reply.updatedAt === "number" });
            expect(reply.content).to.be.a("string"); // should load commentIpfs
            expect(reply.updatedAt).to.be.a("number"); // should load commentUpdate
            expect(reply._commentUpdateIpfsPath).to.be.undefined; // should be undefined for replies since we're not including them in post updates

            // Cleanup
            await reply.stop();
        });
    });
});

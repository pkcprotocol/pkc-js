import { beforeAll, describe, it, beforeEach, afterEach } from "vitest";
import {
    getAvailablePlebbitConfigsToTestAgainst,
    findOrPublishCommentWithDepth,
    itSkipIfRpc,
    publishRandomPost,
    publishRandomReply,
    resolveWhenConditionIsTrue,
    addStringToIpfs,
    createMockedSubplebbitIpns
} from "../../../dist/node/test/test-util.js";
import signers from "../../fixtures/signers.js";
import type { Plebbit } from "../../../dist/node/plebbit/plebbit.js";
import type { RemoteSubplebbit } from "../../../dist/node/subplebbit/remote-subplebbit.js";
import type { PlebbitError } from "../../../dist/node/plebbit-error.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";
import {
    findUpdatingComment,
    findUpdatingSubplebbit,
    listUpdatingComments,
    listUpdatingSubplebbits
} from "../../../dist/node/plebbit/tracked-instance-registry-util.js";

const subplebbitAddress = signers[0].address;

// TODO write a better way to wait for events to propgate other than setTimeout
getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe(`plebbit._updatingComments - ${config.name}`, async () => {
        let plebbit: Plebbit;
        let sub: RemoteSubplebbit;

        beforeEach(async () => {
            plebbit = await config.plebbitInstancePromise();
        });
        afterEach(async () => {
            await plebbit.destroy();
        });
        beforeAll(async () => {
            const plebbit = await config.plebbitInstancePromise();
            sub = await plebbit.getSubplebbit({ address: subplebbitAddress });

            const replyWithDepth1Cid = await findOrPublishCommentWithDepth({ depth: 1, subplebbit: sub });
            const replyWithDepth2Cid = await findOrPublishCommentWithDepth({ depth: 2, subplebbit: sub });
            const replyWithDepth3Cid = await findOrPublishCommentWithDepth({ depth: 3, subplebbit: sub });

            const replyPostConfigs = [
                { commentType: "post (depth 0)", cid: sub.posts.pages.hot.comments[0].cid },
                {
                    commentType: "reply (depth 1)",
                    cid: replyWithDepth1Cid.cid
                },
                {
                    commentType: "reply (depth 2)",
                    cid: replyWithDepth2Cid.cid
                },
                {
                    commentType: "reply (depth 3)",
                    cid: replyWithDepth3Cid.cid
                }
            ];

            expect(replyPostConfigs[0].cid).to.be.a("string");
            expect(replyPostConfigs[1].cid).to.be.a("string");
            expect(replyPostConfigs[2].cid).to.be.a("string");
            expect(replyPostConfigs[3].cid).to.be.a("string");

            // Dynamically define test cases here now that replyPostConfigs is available
            for (const replyPostConfig of replyPostConfigs) {
                runTestsForCommentType(replyPostConfig);
            }
            await plebbit.destroy();
        });

        // Function to define test cases for a specific comment type
        function runTestsForCommentType(replyPostConfig: { commentType: string; cid: string }) {
            let plebbit: Plebbit;

            beforeEach(async () => {
                plebbit = await config.plebbitInstancePromise();
            });
            afterEach(async () => {
                try {
                    await plebbit.destroy();
                } catch {}
            });
            describe(`Tests for ${replyPostConfig.commentType}`, () => {
                it(`Calling plebbit.createComment({${replyPostConfig.commentType}cid}) when ${replyPostConfig.commentType} is already updating in plebbit._updatingComments should get us CommentIpfs and CommentUpdate`, async () => {
                    const comment1 = await plebbit.createComment({ cid: replyPostConfig.cid });
                    await comment1.update();
                    await resolveWhenConditionIsTrue({ toUpdate: comment1, predicate: async () => typeof comment1.updatedAt === "number" });
                    expect(plebbit._updatingComments[comment1.cid].listenerCount("update")).to.equal(1);

                    const comment2 = await plebbit.createComment({ cid: comment1.cid });
                    expect(comment2.content).to.be.a("string"); // comment ipfs is defined
                    expect(comment2.updatedAt).to.be.a("number"); // comment update is defined

                    await comment2.update();
                    expect(plebbit._updatingComments[comment1.cid].listenerCount("update")).to.equal(2);

                    await comment1.stop();

                    expect(plebbit._updatingComments[comment1.cid].listenerCount("update")).to.equal(1);

                    await comment2.stop();

                    await new Promise((resolve) => setTimeout(resolve, 100)); // need to wait some time to propgate events

                    expect(plebbit._updatingComments[comment1.cid]).to.be.undefined;
                });

                it(`A single ${replyPostConfig.commentType} instance fetched with plebbit.getComment should not keep plebbit._updatingComments[address]`, async () => {
                    const comment = await plebbit.getComment({ cid: replyPostConfig.cid });
                    expect(comment.content).to.be.a("string");
                    expect(plebbit._updatingComments[comment.cid]).to.be.undefined;
                    expect(plebbit._updatingComments.size()).to.equal(0);
                });

                it(`A single ${replyPostConfig.commentType} instance calling stop() immediately after update() should clear out _updatingComments`, async () => {
                    expect(plebbit._updatingComments.size()).to.equal(0);

                    const comment = await plebbit.createComment({ cid: replyPostConfig.cid });
                    await comment.update();
                    expect(plebbit._updatingComments[comment.cid]).to.exist;
                    expect(plebbit._updatingComments[comment.cid].listenerCount("update")).to.equal(1);

                    await comment.stop();
                    await new Promise((resolve) => setTimeout(resolve, 100)); // need to wait some time to propagate events

                    expect(plebbit._updatingComments[comment.cid]).to.be.undefined;
                    expect(plebbit._updatingComments.size()).to.equal(0); // post should be undefined too
                });

                it(`A single ${replyPostConfig.commentType} Comment instance updating will set up plebbit._updatingComments. Calling stop should clean up all subscriptions and remove plebbit._updatingComments`, async () => {
                    expect(plebbit._updatingComments[replyPostConfig.cid]).to.be.undefined;

                    const comment = await plebbit.createComment({ cid: replyPostConfig.cid });
                    await comment.update();
                    await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" }); // wait until post/subplebbit subscription starts
                    expect(plebbit._updatingComments[comment.cid].listenerCount("update")).to.equal(1);

                    await comment.stop();
                    await new Promise((resolve) => setTimeout(resolve, 100)); // need to wait some time to propagate events

                    expect(plebbit._updatingComments[comment.cid]).to.be.undefined;
                    expect(plebbit._updatingComments[comment.postCid]).to.be.undefined;
                    expect(plebbit._updatingComments.size()).to.equal(0);
                });

                it(`Multiple ${replyPostConfig.commentType} Comment instances (same address) updating. Calling stop on all of them should clean all subscriptions and remove plebbit._updatingComments`, async () => {
                    const comment1 = await plebbit.createComment({ cid: replyPostConfig.cid });
                    const comment2 = await plebbit.createComment({ cid: replyPostConfig.cid });
                    const comment3 = await plebbit.createComment({ cid: replyPostConfig.cid });

                    await comment1.update();
                    await comment2.update();
                    await comment3.update();

                    await Promise.all(
                        [comment1, comment2, comment3].map((comment) =>
                            resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment1.updatedAt === "number" })
                        )
                    );

                    // all comments have received an update event now
                    expect(plebbit._updatingComments[replyPostConfig.cid].updatedAt).to.be.a("number");
                    expect(plebbit._updatingComments[replyPostConfig.cid].state).to.equal("updating");

                    expect(plebbit._updatingComments[replyPostConfig.cid].listenerCount("update")).to.equal(3);

                    await comment1.stop();

                    expect(plebbit._updatingComments[replyPostConfig.cid].listenerCount("update")).to.equal(2);

                    await comment2.stop();

                    expect(plebbit._updatingComments[replyPostConfig.cid].listenerCount("update")).to.equal(1);

                    await comment3.stop();

                    await new Promise((resolve) => setTimeout(resolve, 100)); // need to wait some time to propgate events

                    expect(plebbit._updatingComments[replyPostConfig.cid]).to.be.undefined;
                    expect(plebbit._updatingComments[comment1.postCid]).to.be.undefined;
                    expect(plebbit._updatingComments.size()).to.equal(0);
                });
                it(`calling plebbit._updatingComments[${replyPostConfig.commentType}cid].stop() should stop all ${replyPostConfig.commentType} instances listening to that instance`, async () => {
                    const comment1 = await plebbit.createComment({ cid: replyPostConfig.cid });
                    await comment1.update();
                    expect(comment1.state).to.equal("updating");
                    // plebbit._updatingComments[comment.cid] should be defined now
                    const comment2 = await plebbit.createComment({ cid: comment1.cid });
                    await comment2.update();
                    expect(comment2.state).to.equal("updating");

                    const comment3 = await plebbit.createComment({ cid: comment1.cid });
                    await comment3.update();
                    expect(comment3.state).to.equal("updating");

                    // stopping plebbit._updatingComments should stop all of them

                    await plebbit._updatingComments[comment1.cid].stop();
                    await new Promise((resolve) => setTimeout(resolve, 100)); // need to wait some time to propgate events

                    for (const comment of [comment1, comment2, comment3]) {
                        expect(comment.state).to.equal("stopped");
                        expect(comment.updatingState).to.equal("stopped");
                    }
                    expect(plebbit._updatingComments[comment1.cid]).to.be.undefined;
                });

                it(`Calling plebbit.getComment({cid: ${replyPostConfig.commentType}Cid}) should load both CommentIpfs and CommentUpdate if updating comment instance already has them`, async () => {
                    const comment1 = await plebbit.createComment({ cid: replyPostConfig.cid });
                    await comment1.update();
                    await resolveWhenConditionIsTrue({ toUpdate: comment1, predicate: async () => typeof comment1.updatedAt === "number" });

                    expect(plebbit._updatingComments[comment1.cid].listenerCount("update")).to.equal(1);

                    const comment2 = await plebbit.getComment({ cid: comment1.cid });
                    expect(comment2.content).to.be.a("string");
                    expect(comment2.updatedAt).to.be.a("number");
                    expect(comment2.state).to.equal("stopped");
                    expect(comment2.updatingState).to.equal("stopped");
                });

                it(`Calling ${replyPostConfig.commentType}FromGetComment.stop() should not stop other updating comments`, async () => {
                    const comment1 = await plebbit.createComment({ cid: replyPostConfig.cid });
                    await comment1.update();

                    expect(plebbit._updatingComments[comment1.cid].listenerCount("update")).to.equal(1);

                    const comment2 = await plebbit.getComment({ cid: comment1.cid });
                    await comment2.stop();

                    expect(plebbit._updatingComments[comment1.cid]).to.exist; // comment1 should still be updating
                    expect(plebbit._updatingComments[comment1.cid].listenerCount("update")).to.equal(1);
                });
            });
        }

        // The rest of your standalone tests go here
        it(`findUpdatingComment and listUpdatingComments track one live instance per cid`, async () => {
            const commentCid = sub.posts.pages.hot.comments[0].cid;
            const comment1 = await plebbit.createComment({ cid: commentCid });
            const comment2 = await plebbit.createComment({ cid: commentCid });

            expect(findUpdatingComment(plebbit, { cid: commentCid })).to.be.undefined;
            expect(listUpdatingComments(plebbit)).to.deep.equal([]);

            await comment1.update();
            await comment2.update();

            await Promise.all(
                [comment1, comment2].map((comment) =>
                    resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" })
                )
            );

            expect(findUpdatingComment(plebbit, { cid: commentCid })?.cid).to.equal(commentCid);
            expect(listUpdatingComments(plebbit).filter((trackedComment) => trackedComment.cid === commentCid)).to.have.lengthOf(1);

            await comment1.stop();
            await comment2.stop();
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(findUpdatingComment(plebbit, { cid: commentCid })).to.be.undefined;
            expect(listUpdatingComments(plebbit)).to.deep.equal([]);
        });

        itSkipIfRpc(
            `Stopping the first updating comment shouldn't tear down _updatingSubplebbits while another comment from the same sub is still updating`,
            async () => {
                const firstPost = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
                const secondPost = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });

                const firstComment = await plebbit.createComment({ cid: firstPost.cid });
                const secondComment = await plebbit.createComment({ cid: secondPost.cid });

                await firstComment.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: firstComment,
                    predicate: async () => typeof firstComment.updatedAt === "number"
                });

                await secondComment.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: secondComment,
                    predicate: async () => typeof secondComment.updatedAt === "number"
                });

                const subAddress = firstComment.communityAddress;
                expect(findUpdatingSubplebbit(plebbit, { address: subAddress })).to.exist;

                await firstComment.stop();
                await new Promise((resolve) => setTimeout(resolve, 200));

                expect(findUpdatingSubplebbit(plebbit, { address: subAddress })).to.exist;
                expect(secondComment.state).to.equal("updating");
                expect(findUpdatingComment(plebbit, { cid: secondComment.cid! })).to.exist;

                await secondComment.stop();
                await new Promise((resolve) => setTimeout(resolve, 200));

                expect(findUpdatingSubplebbit(plebbit, { address: subAddress })).to.not.exist;
                expect(listUpdatingComments(plebbit)).to.deep.equal([]);
            }
        );

        it(`doesn't resurrect _updatingComments after stop() when the subplebbit record is invalid`, async () => {
            const { subplebbitRecord, communityAddress: subplebbitAddress, ipnsObj } = await createMockedSubplebbitIpns({});
            const invalidSubplebbitRecord = { ...subplebbitRecord, updatedAt: subplebbitRecord.updatedAt + 9999 };
            await ipnsObj.publishToIpns(JSON.stringify(invalidSubplebbitRecord));

            const postToPublish = await plebbit.createComment({
                signer: await plebbit.createSigner(),
                communityAddress: subplebbitAddress,
                title: `Mock Post - ${Date.now()}`,
                content: `Mock content - ${Date.now()}`
            });
            const postIpfs = { ...postToPublish.raw.pubsubMessageToPublish, depth: 0 };
            const postCid = await addStringToIpfs(JSON.stringify(postIpfs));

            const post = await plebbit.createComment({ cid: postCid });
            const errors: PlebbitError[] = [];
            post.on("error", (e: PlebbitError | Error) => {
                errors.push(e as PlebbitError);
            });

            await post.update();
            await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => errors.length >= 1, eventName: "error" });

            await post.stop();

            expect(listUpdatingComments(plebbit)).to.deep.equal([]);
            expect(listUpdatingSubplebbits(plebbit)).to.deep.equal([]);
        });

        it(`Calling comment.stop() and update() should behave as normal with plebbit._updatingComments`, async () => {
            const comment = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
            const postCommentCid = comment.cid;

            const postComment1 = await plebbit.createComment({ cid: postCommentCid });

            await postComment1.update();
            await resolveWhenConditionIsTrue({ toUpdate: postComment1, predicate: async () => typeof postComment1.updatedAt === "number" });
            expect(findUpdatingComment(plebbit, { cid: postCommentCid })!.listenerCount("update")).to.equal(1);

            const postComment2 = await plebbit.createComment({ cid: postCommentCid });

            await postComment2.update();
            expect(findUpdatingComment(plebbit, { cid: postCommentCid })!.listenerCount("update")).to.equal(2);

            await postComment1.stop();

            expect(findUpdatingComment(plebbit, { cid: postCommentCid })).to.exist;
            expect(findUpdatingComment(plebbit, { cid: postCommentCid })!.listenerCount("update")).to.equal(1);

            const initialReplyCount = postComment2.replyCount;

            await publishRandomReply({ parentComment: postComment2 as CommentIpfsWithCidDefined, plebbit: plebbit });

            // we don't know if another test might publish a reply to postComment2, so we wait until we see a reply count increase
            await resolveWhenConditionIsTrue({
                toUpdate: postComment2,
                predicate: async () => postComment2.replyCount > initialReplyCount
            });

            expect(postComment2.replyCount).to.be.greaterThan(initialReplyCount);

            await postComment2.stop();

            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(findUpdatingComment(plebbit, { cid: postCommentCid })).to.be.undefined;
        });

        it("fails (for now) when an updating comment mirrors itself from _updatingComments", async () => {
            const post = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
            const selfUpdatingComment = await plebbit.createComment({ cid: post.cid });

            // Simulate the CI case where _updatingComments already holds the same instance before update()
            plebbit._updatingComments[selfUpdatingComment.cid] = selfUpdatingComment;

            await selfUpdatingComment.update(); // wires self-listeners because the map points to this same instance

            let thrownError;
            try {
                selfUpdatingComment.emit("updatingstatechange", "fetching-ipfs");
            } catch (err) {
                thrownError = err;
            } finally {
                delete plebbit._updatingComments[selfUpdatingComment.cid];
                await selfUpdatingComment.stop();
                await post.stop();
            }

            // When the recursion bug is fixed this should be undefined, so the test will start passing.
            expect(thrownError).to.be.undefined;
        });

        // with rpc clients we don't create a post instance, the rpc server does it for us
        itSkipIfRpc(
            `Calling reply.stop() when it's subscribed to a post and post is updating only for reply should remove both reply and post from _updatingComments`,
            async () => {
                const replyCid = sub.posts.pages.hot.comments.find((comment) => comment.replies?.pages?.best).replies.pages.best.comments[0]
                    .cid;
                const reply = await plebbit.createComment({ cid: replyCid });
                await reply.update();
                // Get the post CID from the reply's parent

                await reply.update();

                await resolveWhenConditionIsTrue({ toUpdate: reply, predicate: async () => typeof reply.updatedAt === "number" });
                const postCid = reply.postCid;
                // Verify that both the reply and its parent post are in _updatingComments
                expect(findUpdatingComment(plebbit, { cid: replyCid })).to.exist;
                expect(findUpdatingComment(plebbit, { cid: postCid })).to.exist;

                // Verify the reply's CID matches replyCid
                expect(findUpdatingComment(plebbit, { cid: replyCid })!.cid).to.equal(replyCid);

                // Verify the post's CID matches the expected postCid
                expect(findUpdatingComment(plebbit, { cid: postCid })!.cid).to.equal(postCid);

                // Now stop the reply and verify both are removed from _updatingComments
                await reply.stop();
                await new Promise((resolve) => setTimeout(resolve, 500)); // need to wait some time to propgate events
                expect(findUpdatingComment(plebbit, { cid: replyCid })).to.be.undefined;
                expect(findUpdatingComment(plebbit, { cid: postCid })).to.be.undefined;
                expect(listUpdatingComments(plebbit)).to.have.lengthOf(0);
            }
        );

        // with rpc clients we don't create a subplebbit instance, the rpc server does it for us
        itSkipIfRpc(
            `Updating a post should create a new entry in _updatingSubplebbits if we haven't been updating the sub already`,
            async () => {
                const subplebbit = await plebbit.getSubplebbit({ address: signers[0].address });
                const commentCid = subplebbit.posts.pages.hot.comments[0].cid;

                const comment = await plebbit.createComment({ cid: commentCid });

                expect(findUpdatingComment(plebbit, { cid: commentCid })).to.not.exist;
                expect(findUpdatingSubplebbit(plebbit, { address: comment.communityAddress })).to.not.exist;

                await comment.update();
                await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
                expect(findUpdatingComment(plebbit, { cid: commentCid })).to.exist;
                expect(findUpdatingSubplebbit(plebbit, { address: comment.communityAddress })).to.exist;

                await comment.stop();
                await new Promise((resolve) => setTimeout(resolve, 500)); // need to wait some time to propgate events
                expect(findUpdatingComment(plebbit, { cid: commentCid })).to.not.exist;
                expect(findUpdatingSubplebbit(plebbit, { address: comment.communityAddress })).to.not.exist;
            }
        );

        itSkipIfRpc(`Updating a post should use entry in _updatingSubplebbits if it's already updating`, async () => {
            const subplebbit = await plebbit.getSubplebbit({ address: signers[0].address });
            await subplebbit.update();
            const commentCid = subplebbit.posts.pages.hot.comments[0].cid;

            const comment = await plebbit.createComment({ cid: commentCid });

            expect(findUpdatingComment(plebbit, { cid: commentCid })).to.not.exist;
            expect(findUpdatingSubplebbit(plebbit, { address: subplebbit.address })).to.exist;

            await comment.update();
            await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
            expect(findUpdatingComment(plebbit, { cid: commentCid })).to.exist;
            expect(findUpdatingSubplebbit(plebbit, { address: comment.communityAddress })).to.exist;

            await comment.stop();
            await new Promise((resolve) => setTimeout(resolve, 500)); // need to wait some time to propgate events
            expect(findUpdatingComment(plebbit, { cid: commentCid })).to.not.exist;
            expect(findUpdatingSubplebbit(plebbit, { address: comment.communityAddress })).to.exist;
        });
    });
});

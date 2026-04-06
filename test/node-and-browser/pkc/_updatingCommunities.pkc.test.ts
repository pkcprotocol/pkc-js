import {
    getAvailablePKCConfigsToTestAgainst,
    itSkipIfRpc,
    resolveWhenConditionIsTrue,
    itIfRpc,
    publishRandomPost
} from "../../../dist/node/test/test-util.js";
import signers from "../../fixtures/signers.js";
import { describe, it, beforeEach, afterEach } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
// Type helper for accessing internal properties
type CommentWithInternals = { _communityForUpdating?: { subplebbit?: { raw: { subplebbitIpfs: unknown } } } };

const communityAddress = signers[0].address;
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.sequential(`pkc._updatingCommunitys - ${config.name}`, async () => {
        let pkc: PKC;
        beforeEach(async () => {
            pkc = await config.plebbitInstancePromise();
        });
        afterEach(async () => {
            await pkc.destroy();
        });
        it(`A single community instance updating will set up pkc._updatingCommunity. Calling stop should clean up all subscriptions and remove pkc._updatingCommunitys`, async () => {
            const sub = await pkc.createCommunity({ address: communityAddress });
            expect(pkc._updatingCommunitys[communityAddress]).to.be.undefined;

            await sub.update();
            expect(pkc._updatingCommunitys[communityAddress]).to.be.a("object");

            await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
            expect(pkc._updatingCommunitys[communityAddress]).to.be.a("object");
            expect(pkc._updatingCommunitys[communityAddress].raw.subplebbitIpfs).to.deep.equal(sub.raw.subplebbitIpfs);
            await sub.stop();

            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(pkc._updatingCommunitys[communityAddress]).to.be.undefined;
        });

        it("handles self-referenced _updatingCommunitys without recursion", async () => {
            const sub = await pkc.createCommunity({ address: communityAddress });

            // Simulate the case where _updatingCommunitys already points to this instance
            pkc._updatingCommunitys[communityAddress] = sub;

            await sub.update();

            let thrownError;
            try {
                sub.emit("update", sub);
            } catch (err) {
                thrownError = err;
            } finally {
                delete pkc._updatingCommunitys[communityAddress];
                await sub.stop();
            }

            expect(thrownError).to.be.undefined;
        });

        it(`Multiple community instances (same address) updating. Calling stop on all of them should clean all subscriptions and remove pkc._updatingCommunitys`, async () => {
            const sub1 = await pkc.createCommunity({ address: communityAddress });
            const sub2 = await pkc.createCommunity({ address: communityAddress });
            const sub3 = await pkc.createCommunity({ address: communityAddress });

            await sub1.update();
            expect(sub1.state).to.equal("updating");
            await sub2.update();
            expect(sub2.state).to.equal("updating");
            await sub3.update();
            expect(sub3.state).to.equal("updating");

            await Promise.all(
                [sub1, sub2, sub3].map((sub) =>
                    resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" })
                )
            );

            // all subs have received an update event now
            expect(pkc._updatingCommunitys[communityAddress].updatedAt).to.be.a("number");
            expect(pkc._updatingCommunitys[communityAddress].state).to.equal("updating");

            // Check that pkc._updatingCommunitys has the latest updatedAt
            expect(pkc._updatingCommunitys[communityAddress].updatedAt).to.equal(sub1.updatedAt);
            expect(pkc._updatingCommunitys[communityAddress].updatedAt).to.equal(sub2.updatedAt);
            expect(pkc._updatingCommunitys[communityAddress].updatedAt).to.equal(sub3.updatedAt);

            expect(pkc._updatingCommunitys[communityAddress].listenerCount("update")).to.equal(3);

            await sub1.stop();

            expect(pkc._updatingCommunitys[communityAddress].listenerCount("update")).to.equal(2);

            await sub2.stop();

            expect(pkc._updatingCommunitys[communityAddress].listenerCount("update")).to.equal(1);

            await sub3.stop();

            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(pkc._updatingCommunitys[communityAddress]).to.be.undefined;
        });

        it(`Creating a new sub instance when it's already been updating before should give us latest CommunityIpfs on the created sub instance`, async () => {
            const sub1 = await pkc.createCommunity({ address: communityAddress });
            await sub1.update();
            await resolveWhenConditionIsTrue({ toUpdate: sub1, predicate: async () => typeof sub1.updatedAt === "number" });

            // Verify that _updatingCommunitys has the same updatedAt as sub1
            expect(pkc._updatingCommunitys[communityAddress].updatedAt).to.equal(sub1.updatedAt);

            // Verify that _updatingCommunitys has _rawCommunityIpfs if sub1 has it

            expect(pkc._updatingCommunitys[communityAddress].raw.subplebbitIpfs).to.deep.equal(sub1.raw.subplebbitIpfs);

            const sub2 = await pkc.createCommunity({ address: communityAddress });
            expect(sub2.updatedAt).to.be.a("number");

            // Verify that sub2 has the same updatedAt as _updatingCommunitys
            expect(sub2.updatedAt).to.equal(pkc._updatingCommunitys[communityAddress].updatedAt);

            expect(sub2.updatedAt).to.equal(sub1.updatedAt);

            // Verify that sub2 has _rawCommunityIpfs if _updatingCommunitys has it

            expect(pkc._updatingCommunitys[communityAddress].raw.subplebbitIpfs).to.deep.equal(sub2.raw.subplebbitIpfs);

            await sub1.stop();
            await new Promise((resolve) => setTimeout(resolve, 500));
            expect(pkc._updatingCommunitys[communityAddress]).to.be.undefined;
        });

        it(`A single instance fetched with pkc.getCommunity should not keep pkc._updatingCommunitys[address]`, async () => {
            const sub = await pkc.getCommunity({ address: communityAddress });
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(sub.updatedAt).to.be.a("number");
            expect(pkc._updatingCommunitys[communityAddress]).to.be.undefined;
        });

        itSkipIfRpc(
            `Comment instance can fetch updates from pkc._updatingCommunitys. Calling comment.stop will clean subscriptions and remove pkc._updatingCommunitys`,
            async () => {
                const sub = await pkc.getCommunity({ address: communityAddress });
                await new Promise((resolve) => setTimeout(resolve, 100));
                expect(pkc._updatingCommunitys[communityAddress]).to.be.undefined;

                const commentCid = sub.posts.pages.hot.comments[0].cid;
                const comment1 = await pkc.createComment({ cid: commentCid });
                await comment1.update();
                await resolveWhenConditionIsTrue({ toUpdate: comment1, predicate: async () => typeof comment1.updatedAt === "number" });

                // Verify that _updatingCommunitys exists and has the expected properties
                expect(pkc._updatingCommunitys[communityAddress]).to.exist;
                expect(pkc._updatingCommunitys[communityAddress].listenerCount("update")).to.equal(1);

                // Verify that _updatingCommunitys has _rawCommunityIpfs if it should

                expect(pkc._updatingCommunitys[communityAddress].raw.subplebbitIpfs).to.exist;

                await comment1.stop();
                const updatingSubInstance = pkc._updatingCommunitys[communityAddress];
                expect(updatingSubInstance).to.be.undefined;
            }
        );

        itSkipIfRpc(
            `Multiple comment instances of the same sub updating. Calling stop on all of them should clean all subscriptions and remove pkc._updatingCommunitys`,
            async () => {
                expect(pkc._updatingCommunitys[communityAddress]).to.be.undefined;
                const sub = await pkc.getCommunity({ address: communityAddress });
                await new Promise((resolve) => setTimeout(resolve, 100));
                expect(pkc._updatingCommunitys[communityAddress]).to.be.undefined;

                const commentCid = sub.posts.pages.hot.comments[0].cid;
                const comment1 = await pkc.createComment({ cid: commentCid });
                const comment2 = await pkc.createComment({ cid: commentCid });

                expect((comment1 as unknown as CommentWithInternals)._communityForUpdating).to.be.undefined;

                await comment1.update();
                await resolveWhenConditionIsTrue({ toUpdate: comment1, predicate: async () => typeof comment1.updatedAt === "number" });

                const updatingCommentInstance = pkc._updatingComments[comment1.cid] as unknown as CommentWithInternals;
                expect(updatingCommentInstance).to.exist;
                expect(updatingCommentInstance._communityForUpdating).to.be.a("object");

                // Verify that _updatingCommunitys exists and has the expected properties
                expect(pkc._updatingCommunitys[communityAddress]).to.exist;
                expect(pkc._updatingCommunitys[communityAddress].listenerCount("update")).to.equal(1);

                // Verify that _communityForUpdating.subplebbit and _updatingCommunitys[address] have the same _rawCommunityIpfs state

                expect(pkc._updatingCommunitys[communityAddress].raw.subplebbitIpfs).to.deep.equal(
                    updatingCommentInstance._communityForUpdating?.subplebbit?.raw.subplebbitIpfs
                );

                await comment2.update();
                await resolveWhenConditionIsTrue({ toUpdate: comment2, predicate: async () => typeof comment2.updatedAt === "number" });
                expect(updatingCommentInstance._communityForUpdating).to.be.a("object");

                expect(pkc._updatingCommunitys[communityAddress].listenerCount("update")).to.equal(1); // should not change

                expect(pkc._updatingCommunitys[communityAddress].raw.subplebbitIpfs).to.deep.equal(
                    updatingCommentInstance._communityForUpdating?.subplebbit?.raw.subplebbitIpfs
                );

                await comment1.stop();

                expect(pkc._updatingCommunitys[communityAddress].listenerCount("update")).to.equal(1); // should not change

                await comment2.stop();

                expect(pkc._updatingCommunitys[communityAddress]).to.be.undefined;
                expect(pkc._updatingComments[comment1.cid]).to.be.undefined;
            }
        );

        itSkipIfRpc(`can stop two comments in parallel and remove _updatingCommunitys entry`, async () => {
            const post1 = await publishRandomPost({ communityAddress: communityAddress, plebbit: pkc });
            const post2 = await publishRandomPost({ communityAddress: communityAddress, plebbit: pkc });

            const comment1 = await pkc.createComment({ cid: post1.cid });
            const comment2 = await pkc.createComment({ cid: post2.cid });

            await comment1.update();
            await comment2.update();

            await Promise.all(
                [comment1, comment2].map((comment) =>
                    resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" })
                )
            );

            expect(pkc._updatingCommunitys[communityAddress]).to.exist;

            expect(comment1.state).to.equal("updating");
            expect(comment2.state).to.equal("updating");

            await Promise.all([comment1.stop(), comment2.stop()]);
            await new Promise((resolve) => setTimeout(resolve, 200));

            expect(pkc._updatingCommunitys[communityAddress]).to.be.undefined;
            expect(pkc._updatingComments[comment1.cid]).to.be.undefined;
            expect(pkc._updatingComments[comment2.cid]).to.be.undefined;
        });

        it(`calling pkc._updatingCommunitys[communityAddress].stop() should stop all instances listening to that instance`, async () => {
            const sub1 = await pkc.createCommunity({ address: communityAddress });
            await sub1.update();
            expect(sub1.state).to.equal("updating");
            // pkc._updatingCommunitys[communityAddress] should be defined now
            const sub2 = await pkc.createCommunity({ address: communityAddress });
            await sub2.update();
            expect(sub2.state).to.equal("updating");

            const sub3 = await pkc.createCommunity({ address: communityAddress });
            await sub3.update();
            expect(sub3.state).to.equal("updating");

            // stopping pkc._updatingCommunitys should stop all of them

            await pkc._updatingCommunitys[communityAddress].stop();
            await new Promise((resolve) => setTimeout(resolve, 100)); // need to wait some time to propgate events

            for (const community of [sub1, sub2, sub3]) {
                expect(community.state).to.equal("stopped");
                expect(community.updatingState).to.equal("stopped");
            }
            expect(pkc._updatingCommunitys[communityAddress]).to.be.undefined;
        });

        it(`Calling communityFromGetCommunity.stop() should not stop updating instance from pkc._updatingCommunitys`, async () => {
            const sub1 = await pkc.createCommunity({ address: communityAddress });
            await sub1.update();
            expect(sub1.state).to.equal("updating");

            expect(pkc._updatingCommunitys[communityAddress]).to.exist;

            // pkc._updatingCommunitys[communityAddress] should be defined now
            const sub2 = await pkc.getCommunity({ address: communityAddress });
            expect(sub2.state).to.equal("stopped");

            expect(pkc._updatingCommunitys[communityAddress]).to.exist;

            try {
                await sub2.stop();
            } catch (e) {
                expect((e as PKCError).code).to.equal("ERR_CALLED_COMMUNITY_STOP_WITHOUT_UPDATE");
            }
            expect(pkc._updatingCommunitys[communityAddress]).to.exist;

            expect(sub1.state).to.equal("updating");
            expect(pkc._updatingCommunitys[communityAddress].state).to.equal("updating");
        });

        itIfRpc(`can update a local community instance over RPC connection`, async () => {
            const sub = await pkc.createCommunity(); // new sub
            const updatingSub = await pkc.createCommunity({ address: sub.address });
            await updatingSub.update();
            expect(pkc._updatingCommunitys[sub.address]).to.exist;
            await updatingSub.stop();
            expect(sub.state).to.equal("stopped");
        });

        it(`Stopping one community should not affect another community updating entry`, async () => {
            const subA = await pkc.createCommunity({ address: communityAddress });
            const subB = await pkc.createCommunity({ address: signers[1].address });

            await subA.update();
            await subB.update();

            await Promise.all(
                [subA, subB].map((sub) =>
                    resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" })
                )
            );

            expect(pkc._updatingCommunitys[communityAddress]).to.exist;
            expect(pkc._updatingCommunitys[signers[1].address]).to.exist;

            await subA.stop();
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(pkc._updatingCommunitys[communityAddress]).to.be.undefined;
            expect(pkc._updatingCommunitys[signers[1].address]).to.exist;

            await subB.stop();
        });

        itSkipIfRpc(`Comment listeners should restore updating community listener count after cleanup`, async () => {
            const sub = await pkc.createCommunity({ address: communityAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

            const listenerCountOfSub = () => {
                return pkc._updatingCommunitys[sub.address].listenerCount("update");
            };

            const baseListenerCount = listenerCountOfSub();

            const post = await publishRandomPost({ communityAddress: communityAddress, plebbit: pkc });
            const comment = await pkc.createComment({ cid: post.cid });
            await comment.update();
            await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });

            expect(listenerCountOfSub()).to.equal(baseListenerCount + 1);

            await comment.stop();
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(listenerCountOfSub()).to.equal(baseListenerCount);
            await sub.stop();
        });

        itIfRpc(`Updating a comment over RPC should not populate _updatingCommunitys`, async () => {
            const sub = await pkc.getCommunity({ address: communityAddress });
            const postCid = sub.posts.pages.hot.comments[0].cid;
            const comment = await pkc.createComment({ cid: postCid });

            expect(Object.keys(pkc._updatingCommunitys)).to.deep.equal([]);
            await comment.update();
            await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });

            expect(Object.keys(pkc._updatingCommunitys)).to.deep.equal([]);

            await comment.stop();
            expect(Object.keys(pkc._updatingCommunitys)).to.deep.equal([]);
        });
    });
});

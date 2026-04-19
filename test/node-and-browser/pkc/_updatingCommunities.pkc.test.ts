import { getAvailablePKCConfigsToTestAgainst, resolveWhenConditionIsTrue, publishRandomPost } from "../../../dist/node/test/test-util.js";
import { itSkipIfRpc, itIfRpc } from "../../helpers/conditional-tests.js";
import signers from "../../fixtures/signers.js";
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
// Type helper for accessing internal properties
type CommentWithInternals = { _communityForUpdating?: { community?: { raw: { communityIpfs: unknown } } } };

const communityAddress = signers[0].address;
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.sequential(`pkc._updatingCommunities - ${config.name}`, async () => {
        let pkc: PKC;
        beforeEach(async () => {
            pkc = await config.pkcInstancePromise();
        });
        afterEach(async () => {
            await pkc.destroy();
        });
        it(`A single community instance updating will set up pkc._updatingCommunity. Calling stop should clean up all subscriptions and remove pkc._updatingCommunities`, async () => {
            const community = await pkc.createCommunity({ address: communityAddress });
            expect(pkc._updatingCommunities[communityAddress]).to.be.undefined;

            await community.update();
            expect(pkc._updatingCommunities[communityAddress]).to.be.a("object");

            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            expect(pkc._updatingCommunities[communityAddress]).to.be.a("object");
            expect(pkc._updatingCommunities[communityAddress].raw.communityIpfs).to.deep.equal(community.raw.communityIpfs);
            await community.stop();

            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(pkc._updatingCommunities[communityAddress]).to.be.undefined;
        });

        it("handles self-referenced _updatingCommunities without recursion", async () => {
            const community = await pkc.createCommunity({ address: communityAddress });

            // Simulate the case where _updatingCommunities already points to this instance
            pkc._updatingCommunities[communityAddress] = community;

            await community.update();

            let thrownError;
            try {
                community.emit("update", community);
            } catch (err) {
                thrownError = err;
            } finally {
                delete pkc._updatingCommunities[communityAddress];
                await community.stop();
            }

            expect(thrownError).to.be.undefined;
        });

        it(`Multiple community instances (same address) updating. Calling stop on all of them should clean all subscriptions and remove pkc._updatingCommunities`, async () => {
            const community1 = await pkc.createCommunity({ address: communityAddress });
            const community2 = await pkc.createCommunity({ address: communityAddress });
            const sub3 = await pkc.createCommunity({ address: communityAddress });

            await community1.update();
            expect(community1.state).to.equal("updating");
            await community2.update();
            expect(community2.state).to.equal("updating");
            await sub3.update();
            expect(sub3.state).to.equal("updating");

            await Promise.all(
                [community1, community2, sub3].map((community) =>
                    resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" })
                )
            );

            // all subs have received an update event now
            expect(pkc._updatingCommunities[communityAddress].updatedAt).to.be.a("number");
            expect(pkc._updatingCommunities[communityAddress].state).to.equal("updating");

            // Check that pkc._updatingCommunities has the latest updatedAt
            expect(pkc._updatingCommunities[communityAddress].updatedAt).to.equal(community1.updatedAt);
            expect(pkc._updatingCommunities[communityAddress].updatedAt).to.equal(community2.updatedAt);
            expect(pkc._updatingCommunities[communityAddress].updatedAt).to.equal(sub3.updatedAt);

            expect(pkc._updatingCommunities[communityAddress].listenerCount("update")).to.equal(3);

            await community1.stop();

            expect(pkc._updatingCommunities[communityAddress].listenerCount("update")).to.equal(2);

            await community2.stop();

            expect(pkc._updatingCommunities[communityAddress].listenerCount("update")).to.equal(1);

            await sub3.stop();

            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(pkc._updatingCommunities[communityAddress]).to.be.undefined;
        });

        it(`Creating a new community instance when it's already been updating before should give us latest CommunityIpfs on the created community instance`, async () => {
            const community1 = await pkc.createCommunity({ address: communityAddress });
            await community1.update();
            await resolveWhenConditionIsTrue({ toUpdate: community1, predicate: async () => typeof community1.updatedAt === "number" });

            // Verify that _updatingCommunities has the same updatedAt as community1
            expect(pkc._updatingCommunities[communityAddress].updatedAt).to.equal(community1.updatedAt);

            // Verify that _updatingCommunities has _rawCommunityIpfs if community1 has it

            expect(pkc._updatingCommunities[communityAddress].raw.communityIpfs).to.deep.equal(community1.raw.communityIpfs);

            const community2 = await pkc.createCommunity({ address: communityAddress });
            expect(community2.updatedAt).to.be.a("number");

            // Verify that community2 has the same updatedAt as _updatingCommunities
            expect(community2.updatedAt).to.equal(pkc._updatingCommunities[communityAddress].updatedAt);

            expect(community2.updatedAt).to.equal(community1.updatedAt);

            // Verify that community2 has _rawCommunityIpfs if _updatingCommunities has it

            expect(pkc._updatingCommunities[communityAddress].raw.communityIpfs).to.deep.equal(community2.raw.communityIpfs);

            await community1.stop();
            await new Promise((resolve) => setTimeout(resolve, 500));
            expect(pkc._updatingCommunities[communityAddress]).to.be.undefined;
        });

        it(`A single instance fetched with pkc.getCommunity should not keep pkc._updatingCommunities[address]`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(community.updatedAt).to.be.a("number");
            expect(pkc._updatingCommunities[communityAddress]).to.be.undefined;
        });

        itSkipIfRpc(
            `Comment instance can fetch updates from pkc._updatingCommunities. Calling comment.stop will clean subscriptions and remove pkc._updatingCommunities`,
            async () => {
                const community = await pkc.getCommunity({ address: communityAddress });
                await new Promise((resolve) => setTimeout(resolve, 100));
                expect(pkc._updatingCommunities[communityAddress]).to.be.undefined;

                const commentCid = community.posts.pages.hot.comments[0].cid;
                const comment1 = await pkc.createComment({ cid: commentCid });
                await comment1.update();
                await resolveWhenConditionIsTrue({ toUpdate: comment1, predicate: async () => typeof comment1.updatedAt === "number" });

                // Verify that _updatingCommunities exists and has the expected properties
                expect(pkc._updatingCommunities[communityAddress]).to.exist;
                expect(pkc._updatingCommunities[communityAddress].listenerCount("update")).to.equal(1);

                // Verify that _updatingCommunities has _rawCommunityIpfs if it should

                expect(pkc._updatingCommunities[communityAddress].raw.communityIpfs).to.exist;

                await comment1.stop();
                const updatingSubInstance = pkc._updatingCommunities[communityAddress];
                expect(updatingSubInstance).to.be.undefined;
            }
        );

        itSkipIfRpc(
            `Multiple comment instances of the same sub updating. Calling stop on all of them should clean all subscriptions and remove pkc._updatingCommunities`,
            async () => {
                expect(pkc._updatingCommunities[communityAddress]).to.be.undefined;
                const community = await pkc.getCommunity({ address: communityAddress });
                await new Promise((resolve) => setTimeout(resolve, 100));
                expect(pkc._updatingCommunities[communityAddress]).to.be.undefined;

                const commentCid = community.posts.pages.hot.comments[0].cid;
                const comment1 = await pkc.createComment({ cid: commentCid });
                const comment2 = await pkc.createComment({ cid: commentCid });

                expect((comment1 as unknown as CommentWithInternals)._communityForUpdating).to.be.undefined;

                await comment1.update();
                await resolveWhenConditionIsTrue({ toUpdate: comment1, predicate: async () => typeof comment1.updatedAt === "number" });

                const updatingCommentInstance = pkc._updatingComments[comment1.cid] as unknown as CommentWithInternals;
                expect(updatingCommentInstance).to.exist;
                expect(updatingCommentInstance._communityForUpdating).to.be.a("object");

                // Verify that _updatingCommunities exists and has the expected properties
                expect(pkc._updatingCommunities[communityAddress]).to.exist;
                expect(pkc._updatingCommunities[communityAddress].listenerCount("update")).to.equal(1);

                // Verify that _communityForUpdating.community and _updatingCommunities[address] have the same _rawCommunityIpfs state

                expect(pkc._updatingCommunities[communityAddress].raw.communityIpfs).to.deep.equal(
                    updatingCommentInstance._communityForUpdating?.community?.raw.communityIpfs
                );

                await comment2.update();
                await resolveWhenConditionIsTrue({ toUpdate: comment2, predicate: async () => typeof comment2.updatedAt === "number" });
                expect(updatingCommentInstance._communityForUpdating).to.be.a("object");

                expect(pkc._updatingCommunities[communityAddress].listenerCount("update")).to.equal(1); // should not change

                expect(pkc._updatingCommunities[communityAddress].raw.communityIpfs).to.deep.equal(
                    updatingCommentInstance._communityForUpdating?.community?.raw.communityIpfs
                );

                await comment1.stop();

                expect(pkc._updatingCommunities[communityAddress].listenerCount("update")).to.equal(1); // should not change

                await comment2.stop();

                expect(pkc._updatingCommunities[communityAddress]).to.be.undefined;
                expect(pkc._updatingComments[comment1.cid]).to.be.undefined;
            }
        );

        itSkipIfRpc(`can stop two comments in parallel and remove _updatingCommunities entry`, async () => {
            const post1 = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            const post2 = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });

            const comment1 = await pkc.createComment({ cid: post1.cid });
            const comment2 = await pkc.createComment({ cid: post2.cid });

            await comment1.update();
            await comment2.update();

            await Promise.all(
                [comment1, comment2].map((comment) =>
                    resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" })
                )
            );

            expect(pkc._updatingCommunities[communityAddress]).to.exist;

            expect(comment1.state).to.equal("updating");
            expect(comment2.state).to.equal("updating");

            await Promise.all([comment1.stop(), comment2.stop()]);
            await new Promise((resolve) => setTimeout(resolve, 200));

            expect(pkc._updatingCommunities[communityAddress]).to.be.undefined;
            expect(pkc._updatingComments[comment1.cid]).to.be.undefined;
            expect(pkc._updatingComments[comment2.cid]).to.be.undefined;
        });

        it(`calling pkc._updatingCommunities[communityAddress].stop() should stop all instances listening to that instance`, async () => {
            const community1 = await pkc.createCommunity({ address: communityAddress });
            await community1.update();
            expect(community1.state).to.equal("updating");
            // pkc._updatingCommunities[communityAddress] should be defined now
            const community2 = await pkc.createCommunity({ address: communityAddress });
            await community2.update();
            expect(community2.state).to.equal("updating");

            const sub3 = await pkc.createCommunity({ address: communityAddress });
            await sub3.update();
            expect(sub3.state).to.equal("updating");

            // stopping pkc._updatingCommunities should stop all of them

            await pkc._updatingCommunities[communityAddress].stop();
            await new Promise((resolve) => setTimeout(resolve, 100)); // need to wait some time to propgate events

            for (const community of [community1, community2, sub3]) {
                expect(community.state).to.equal("stopped");
                expect(community.updatingState).to.equal("stopped");
            }
            expect(pkc._updatingCommunities[communityAddress]).to.be.undefined;
        });

        it(`Calling communityFromGetCommunity.stop() should not stop updating instance from pkc._updatingCommunities`, async () => {
            const community1 = await pkc.createCommunity({ address: communityAddress });
            await community1.update();
            expect(community1.state).to.equal("updating");

            expect(pkc._updatingCommunities[communityAddress]).to.exist;

            // pkc._updatingCommunities[communityAddress] should be defined now
            const community2 = await pkc.getCommunity({ address: communityAddress });
            expect(community2.state).to.equal("stopped");

            expect(pkc._updatingCommunities[communityAddress]).to.exist;

            try {
                await community2.stop();
            } catch (e) {
                expect((e as PKCError).code).to.equal("ERR_CALLED_COMMUNITY_STOP_WITHOUT_UPDATE");
            }
            expect(pkc._updatingCommunities[communityAddress]).to.exist;

            expect(community1.state).to.equal("updating");
            expect(pkc._updatingCommunities[communityAddress].state).to.equal("updating");
        });

        itIfRpc(`can update a local community instance over RPC connection`, async () => {
            const community = await pkc.createCommunity(); // new community
            const updatingCommunity = await pkc.createCommunity({ address: community.address });
            await updatingCommunity.update();
            expect(pkc._updatingCommunities[community.address]).to.exist;
            await updatingCommunity.stop();
            expect(community.state).to.equal("stopped");
        });

        it(`Stopping one community should not affect another community updating entry`, async () => {
            const subA = await pkc.createCommunity({ address: communityAddress });
            const subB = await pkc.createCommunity({ address: signers[1].address });

            await subA.update();
            await subB.update();

            await Promise.all(
                [subA, subB].map((community) =>
                    resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" })
                )
            );

            expect(pkc._updatingCommunities[communityAddress]).to.exist;
            expect(pkc._updatingCommunities[signers[1].address]).to.exist;

            await subA.stop();
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(pkc._updatingCommunities[communityAddress]).to.be.undefined;
            expect(pkc._updatingCommunities[signers[1].address]).to.exist;

            await subB.stop();
        });

        itSkipIfRpc(`Comment listeners should restore updating community listener count after cleanup`, async () => {
            const community = await pkc.createCommunity({ address: communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

            const listenerCountOfSub = () => {
                return pkc._updatingCommunities[community.address].listenerCount("update");
            };

            const baseListenerCount = listenerCountOfSub();

            const post = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            const comment = await pkc.createComment({ cid: post.cid });
            await comment.update();
            await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });

            expect(listenerCountOfSub()).to.equal(baseListenerCount + 1);

            await comment.stop();
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(listenerCountOfSub()).to.equal(baseListenerCount);
            await community.stop();
        });

        // Regression: update() should not mirror a stopped entry from _updatingCommunities.
        // Reproduces a race condition where concurrent callers both create updating community
        // entries with the same name alias. When one stops, the other should still receive updates.
        it(`Stopping one mirroring community should not break another community mirroring the same shared entry`, async () => {
            const nameCommunitySigner = signers[3];

            // 1. Create a community by IPNS key — its record has name: 'plebbit.bso'
            const communityByKey = await pkc.createCommunity({ address: nameCommunitySigner.address });
            await communityByKey.update();
            await resolveWhenConditionIsTrue({
                toUpdate: communityByKey,
                predicate: async () => typeof communityByKey.updatedAt === "number"
            });
            expect(communityByKey.name).to.equal("plebbit.bso");
            // Now _updatingCommunities has an entry with alias 'plebbit.bso'

            // 2. While communityByKey is still updating, create a domain community and update it.
            //    update() will find communityByKey's entry via the shared name alias and mirror to it.
            const communityByDomain = await pkc.createCommunity({ address: "plebbit.bso" });
            const oldUpdatedAt = communityByDomain.updatedAt;
            await communityByDomain.update();

            // 3. Stop communityByKey — this tears down one consumer but the shared entry should survive
            await communityByKey.stop();

            // 4. Publish a post to trigger a new community update on the server
            await publishRandomPost({ communityAddress: "plebbit.bso", pkc: pkc });

            // 5. communityByDomain should still receive updates despite communityByKey being stopped.
            //    Without the fix, communityByDomain mirrors a dead entry and hangs forever.
            await resolveWhenConditionIsTrue({
                toUpdate: communityByDomain,
                predicate: async () => oldUpdatedAt !== communityByDomain.updatedAt
            });
            expect(communityByDomain.updatedAt).to.not.equal(oldUpdatedAt);
            await communityByDomain.stop();
        });

        // Regression: reproduces the race condition from the CI failure in update.community.test.ts:99.
        // When _numOfListenersForUpdatingInstance drops to 0, the underlying community's stop() is async.
        // During the async window, findUpdatingCommunity still finds the dying entry, and a new
        // community that mirrors it gets killed when the pending stop cascades.
        it(`update() called during async stop window should not mirror a dying _updatingCommunities entry`, async () => {
            const nameCommunitySigner = signers[3];

            // 1. Create a community by IPNS key — after update, its name becomes 'plebbit.bso',
            //    so _updatingCommunities gets an entry aliased under both the key AND 'plebbit.bso'
            const communityByKey = await pkc.createCommunity({ address: nameCommunitySigner.address });
            await communityByKey.update();
            await resolveWhenConditionIsTrue({
                toUpdate: communityByKey,
                predicate: async () => typeof communityByKey.updatedAt === "number"
            });

            // Verify _updatingCommunities has an entry reachable by both the key and domain alias
            expect(pkc._updatingCommunities[nameCommunitySigner.address]).to.exist;
            expect(pkc._updatingCommunities["plebbit.bso"]).to.exist;
            // Both aliases point to the same underlying entry
            expect(pkc._updatingCommunities[nameCommunitySigner.address]).to.equal(pkc._updatingCommunities["plebbit.bso"]);

            // 2. One-shot fetch of the domain community to get initial data
            const communityByDomain = await pkc.getCommunity({ address: "plebbit.bso" });
            const oldUpdatedAt = communityByDomain.updatedAt;
            expect(oldUpdatedAt).to.be.a("number");

            // After getCommunity, communityByKey's entry should still be there
            expect(pkc._updatingCommunities[nameCommunitySigner.address]).to.exist;

            // 3. Stop communityByKey WITHOUT awaiting — creates the race window.
            //    Internally: _numOfListenersForUpdatingInstance drops to 0,
            //    underlying.stop() starts but is awaiting RPC unsubscribe.
            //    The entry is still in _updatingCommunities during this window.
            const stopPromise = communityByKey.stop();

            // 4. Immediately call update() on the domain community.
            //    BUG: findUpdatingCommunity finds the dying entry via "plebbit.bso" alias,
            //    mirrors it, then the pending stop cascades and kills this community.
            //    FIX: The entry should be untracked before stop(), so it's not found.
            await communityByDomain.update();

            // 5. Let the stop complete
            await stopPromise;

            // 6. After the stop, communityByDomain should still be updating with a fresh entry
            expect(communityByDomain.state).to.equal("updating");
            expect(pkc._updatingCommunities["plebbit.bso"]).to.exist;

            // 7. Publish a post to trigger a new community IPNS record
            await publishRandomPost({ communityAddress: "plebbit.bso", pkc });

            // 8. communityByDomain should still receive updates
            await resolveWhenConditionIsTrue({
                toUpdate: communityByDomain,
                predicate: async () => oldUpdatedAt !== communityByDomain.updatedAt
            });
            expect(communityByDomain.updatedAt).to.not.equal(oldUpdatedAt);

            await communityByDomain.stop();

            // 9. After stopping, _updatingCommunities should be fully cleaned up
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(pkc._updatingCommunities["plebbit.bso"]).to.be.undefined;
            expect(pkc._updatingCommunities[nameCommunitySigner.address]).to.be.undefined;
        });

        itIfRpc(`Updating a comment over RPC should not populate _updatingCommunities`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            const postCid = community.posts.pages.hot.comments[0].cid;
            const comment = await pkc.createComment({ cid: postCid });

            expect(Object.keys(pkc._updatingCommunities)).to.deep.equal([]);
            await comment.update();
            await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });

            expect(Object.keys(pkc._updatingCommunities)).to.deep.equal([]);

            await comment.stop();
            expect(Object.keys(pkc._updatingCommunities)).to.deep.equal([]);
        });
    });
});

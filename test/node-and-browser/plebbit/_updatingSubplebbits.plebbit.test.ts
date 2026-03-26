import {
    getAvailablePlebbitConfigsToTestAgainst,
    itSkipIfRpc,
    resolveWhenConditionIsTrue,
    itIfRpc,
    publishRandomPost
} from "../../../dist/node/test/test-util.js";
import signers from "../../fixtures/signers.js";
import { describe, it, beforeEach, afterEach } from "vitest";
import type { Plebbit } from "../../../dist/node/plebbit/plebbit.js";
import type { PlebbitError } from "../../../dist/node/plebbit-error.js";
// Type helper for accessing internal properties
type CommentWithInternals = { _subplebbitForUpdating?: { subplebbit?: { raw: { subplebbitIpfs: unknown } } } };

const subplebbitAddress = signers[0].address;
getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.sequential(`plebbit._updatingSubplebbits - ${config.name}`, async () => {
        let plebbit: Plebbit;
        beforeEach(async () => {
            plebbit = await config.plebbitInstancePromise();
        });
        afterEach(async () => {
            await plebbit.destroy();
        });
        it(`A single subplebbit instance updating will set up plebbit._updatingSubplebbit. Calling stop should clean up all subscriptions and remove plebbit._updatingSubplebbits`, async () => {
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.be.undefined;

            await sub.update();
            expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.be.a("object");

            await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
            expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.be.a("object");
            expect(plebbit._updatingSubplebbits[subplebbitAddress].raw.subplebbitIpfs).to.deep.equal(sub.raw.subplebbitIpfs);
            await sub.stop();

            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.be.undefined;
        });

        it("handles self-referenced _updatingSubplebbits without recursion", async () => {
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });

            // Simulate the case where _updatingSubplebbits already points to this instance
            plebbit._updatingSubplebbits[subplebbitAddress] = sub;

            await sub.update();

            let thrownError;
            try {
                sub.emit("update", sub);
            } catch (err) {
                thrownError = err;
            } finally {
                delete plebbit._updatingSubplebbits[subplebbitAddress];
                await sub.stop();
            }

            expect(thrownError).to.be.undefined;
        });

        it(`Multiple subplebbit instances (same address) updating. Calling stop on all of them should clean all subscriptions and remove plebbit._updatingSubplebbits`, async () => {
            const sub1 = await plebbit.createSubplebbit({ address: subplebbitAddress });
            const sub2 = await plebbit.createSubplebbit({ address: subplebbitAddress });
            const sub3 = await plebbit.createSubplebbit({ address: subplebbitAddress });

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
            expect(plebbit._updatingSubplebbits[subplebbitAddress].updatedAt).to.be.a("number");
            expect(plebbit._updatingSubplebbits[subplebbitAddress].state).to.equal("updating");

            // Check that plebbit._updatingSubplebbits has the latest updatedAt
            expect(plebbit._updatingSubplebbits[subplebbitAddress].updatedAt).to.equal(sub1.updatedAt);
            expect(plebbit._updatingSubplebbits[subplebbitAddress].updatedAt).to.equal(sub2.updatedAt);
            expect(plebbit._updatingSubplebbits[subplebbitAddress].updatedAt).to.equal(sub3.updatedAt);

            expect(plebbit._updatingSubplebbits[subplebbitAddress].listenerCount("update")).to.equal(3);

            await sub1.stop();

            expect(plebbit._updatingSubplebbits[subplebbitAddress].listenerCount("update")).to.equal(2);

            await sub2.stop();

            expect(plebbit._updatingSubplebbits[subplebbitAddress].listenerCount("update")).to.equal(1);

            await sub3.stop();

            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.be.undefined;
        });

        it(`Creating a new sub instance when it's already been updating before should give us latest SubplebbitIpfs on the created sub instance`, async () => {
            const sub1 = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub1.update();
            await resolveWhenConditionIsTrue({ toUpdate: sub1, predicate: async () => typeof sub1.updatedAt === "number" });

            // Verify that _updatingSubplebbits has the same updatedAt as sub1
            expect(plebbit._updatingSubplebbits[subplebbitAddress].updatedAt).to.equal(sub1.updatedAt);

            // Verify that _updatingSubplebbits has _rawSubplebbitIpfs if sub1 has it

            expect(plebbit._updatingSubplebbits[subplebbitAddress].raw.subplebbitIpfs).to.deep.equal(sub1.raw.subplebbitIpfs);

            const sub2 = await plebbit.createSubplebbit({ address: subplebbitAddress });
            expect(sub2.updatedAt).to.be.a("number");

            // Verify that sub2 has the same updatedAt as _updatingSubplebbits
            expect(sub2.updatedAt).to.equal(plebbit._updatingSubplebbits[subplebbitAddress].updatedAt);

            expect(sub2.updatedAt).to.equal(sub1.updatedAt);

            // Verify that sub2 has _rawSubplebbitIpfs if _updatingSubplebbits has it

            expect(plebbit._updatingSubplebbits[subplebbitAddress].raw.subplebbitIpfs).to.deep.equal(sub2.raw.subplebbitIpfs);

            await sub1.stop();
            await new Promise((resolve) => setTimeout(resolve, 500));
            expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.be.undefined;
        });

        it(`A single instance fetched with plebbit.getSubplebbit should not keep plebbit._updatingSubplebbits[address]`, async () => {
            const sub = await plebbit.getSubplebbit({ address: subplebbitAddress });
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(sub.updatedAt).to.be.a("number");
            expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.be.undefined;
        });

        itSkipIfRpc(
            `Comment instance can fetch updates from plebbit._updatingSubplebbits. Calling comment.stop will clean subscriptions and remove plebbit._updatingSubplebbits`,
            async () => {
                const sub = await plebbit.getSubplebbit({ address: subplebbitAddress });
                await new Promise((resolve) => setTimeout(resolve, 100));
                expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.be.undefined;

                const commentCid = sub.posts.pages.hot.comments[0].cid;
                const comment1 = await plebbit.createComment({ cid: commentCid });
                await comment1.update();
                await resolveWhenConditionIsTrue({ toUpdate: comment1, predicate: async () => typeof comment1.updatedAt === "number" });

                // Verify that _updatingSubplebbits exists and has the expected properties
                expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.exist;
                expect(plebbit._updatingSubplebbits[subplebbitAddress].listenerCount("update")).to.equal(1);

                // Verify that _updatingSubplebbits has _rawSubplebbitIpfs if it should

                expect(plebbit._updatingSubplebbits[subplebbitAddress].raw.subplebbitIpfs).to.exist;

                await comment1.stop();
                const updatingSubInstance = plebbit._updatingSubplebbits[subplebbitAddress];
                expect(updatingSubInstance).to.be.undefined;
            }
        );

        itSkipIfRpc(
            `Multiple comment instances of the same sub updating. Calling stop on all of them should clean all subscriptions and remove plebbit._updatingSubplebbits`,
            async () => {
                expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.be.undefined;
                const sub = await plebbit.getSubplebbit({ address: subplebbitAddress });
                await new Promise((resolve) => setTimeout(resolve, 100));
                expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.be.undefined;

                const commentCid = sub.posts.pages.hot.comments[0].cid;
                const comment1 = await plebbit.createComment({ cid: commentCid });
                const comment2 = await plebbit.createComment({ cid: commentCid });

                expect((comment1 as unknown as CommentWithInternals)._subplebbitForUpdating).to.be.undefined;

                await comment1.update();
                await resolveWhenConditionIsTrue({ toUpdate: comment1, predicate: async () => typeof comment1.updatedAt === "number" });

                const updatingCommentInstance = plebbit._updatingComments[comment1.cid] as unknown as CommentWithInternals;
                expect(updatingCommentInstance).to.exist;
                expect(updatingCommentInstance._subplebbitForUpdating).to.be.a("object");

                // Verify that _updatingSubplebbits exists and has the expected properties
                expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.exist;
                expect(plebbit._updatingSubplebbits[subplebbitAddress].listenerCount("update")).to.equal(1);

                // Verify that _subplebbitForUpdating.subplebbit and _updatingSubplebbits[address] have the same _rawSubplebbitIpfs state

                expect(plebbit._updatingSubplebbits[subplebbitAddress].raw.subplebbitIpfs).to.deep.equal(
                    updatingCommentInstance._subplebbitForUpdating?.subplebbit?.raw.subplebbitIpfs
                );

                await comment2.update();
                await resolveWhenConditionIsTrue({ toUpdate: comment2, predicate: async () => typeof comment2.updatedAt === "number" });
                expect(updatingCommentInstance._subplebbitForUpdating).to.be.a("object");

                expect(plebbit._updatingSubplebbits[subplebbitAddress].listenerCount("update")).to.equal(1); // should not change

                expect(plebbit._updatingSubplebbits[subplebbitAddress].raw.subplebbitIpfs).to.deep.equal(
                    updatingCommentInstance._subplebbitForUpdating?.subplebbit?.raw.subplebbitIpfs
                );

                await comment1.stop();

                expect(plebbit._updatingSubplebbits[subplebbitAddress].listenerCount("update")).to.equal(1); // should not change

                await comment2.stop();

                expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.be.undefined;
                expect(plebbit._updatingComments[comment1.cid]).to.be.undefined;
            }
        );

        itSkipIfRpc(`can stop two comments in parallel and remove _updatingSubplebbits entry`, async () => {
            const post1 = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
            const post2 = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });

            const comment1 = await plebbit.createComment({ cid: post1.cid });
            const comment2 = await plebbit.createComment({ cid: post2.cid });

            await comment1.update();
            await comment2.update();

            await Promise.all(
                [comment1, comment2].map((comment) =>
                    resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" })
                )
            );

            expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.exist;

            expect(comment1.state).to.equal("updating");
            expect(comment2.state).to.equal("updating");

            await Promise.all([comment1.stop(), comment2.stop()]);
            await new Promise((resolve) => setTimeout(resolve, 200));

            expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.be.undefined;
            expect(plebbit._updatingComments[comment1.cid]).to.be.undefined;
            expect(plebbit._updatingComments[comment2.cid]).to.be.undefined;
        });

        it(`calling plebbit._updatingSubplebbits[subplebbitAddress].stop() should stop all instances listening to that instance`, async () => {
            const sub1 = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub1.update();
            expect(sub1.state).to.equal("updating");
            // plebbit._updatingSubplebbits[subplebbitAddress] should be defined now
            const sub2 = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub2.update();
            expect(sub2.state).to.equal("updating");

            const sub3 = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub3.update();
            expect(sub3.state).to.equal("updating");

            // stopping plebbit._updatingSubplebbits should stop all of them

            await plebbit._updatingSubplebbits[subplebbitAddress].stop();
            await new Promise((resolve) => setTimeout(resolve, 100)); // need to wait some time to propgate events

            for (const subplebbit of [sub1, sub2, sub3]) {
                expect(subplebbit.state).to.equal("stopped");
                expect(subplebbit.updatingState).to.equal("stopped");
            }
            expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.be.undefined;
        });

        it(`Calling subplebbitFromGetSubplebbit.stop() should not stop updating instance from plebbit._updatingSubplebbits`, async () => {
            const sub1 = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub1.update();
            expect(sub1.state).to.equal("updating");

            expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.exist;

            // plebbit._updatingSubplebbits[subplebbitAddress] should be defined now
            const sub2 = await plebbit.getSubplebbit({ address: subplebbitAddress });
            expect(sub2.state).to.equal("stopped");

            expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.exist;

            try {
                await sub2.stop();
            } catch (e) {
                expect((e as PlebbitError).code).to.equal("ERR_CALLED_SUBPLEBBIT_STOP_WITHOUT_UPDATE");
            }
            expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.exist;

            expect(sub1.state).to.equal("updating");
            expect(plebbit._updatingSubplebbits[subplebbitAddress].state).to.equal("updating");
        });

        itIfRpc(`can update a local subplebbit instance over RPC connection`, async () => {
            const sub = await plebbit.createSubplebbit(); // new sub
            const updatingSub = await plebbit.createSubplebbit({ address: sub.address });
            await updatingSub.update();
            expect(plebbit._updatingSubplebbits[sub.address]).to.exist;
            await updatingSub.stop();
            expect(sub.state).to.equal("stopped");
        });

        it(`Stopping one subplebbit should not affect another subplebbit updating entry`, async () => {
            const subA = await plebbit.createSubplebbit({ address: subplebbitAddress });
            const subB = await plebbit.createSubplebbit({ address: signers[1].address });

            await subA.update();
            await subB.update();

            await Promise.all(
                [subA, subB].map((sub) =>
                    resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" })
                )
            );

            expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.exist;
            expect(plebbit._updatingSubplebbits[signers[1].address]).to.exist;

            await subA.stop();
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(plebbit._updatingSubplebbits[subplebbitAddress]).to.be.undefined;
            expect(plebbit._updatingSubplebbits[signers[1].address]).to.exist;

            await subB.stop();
        });

        itSkipIfRpc(`Comment listeners should restore updating subplebbit listener count after cleanup`, async () => {
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

            const listenerCountOfSub = () => {
                return plebbit._updatingSubplebbits[sub.address].listenerCount("update");
            };

            const baseListenerCount = listenerCountOfSub();

            const post = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
            const comment = await plebbit.createComment({ cid: post.cid });
            await comment.update();
            await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });

            expect(listenerCountOfSub()).to.equal(baseListenerCount + 1);

            await comment.stop();
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(listenerCountOfSub()).to.equal(baseListenerCount);
            await sub.stop();
        });

        itIfRpc(`Updating a comment over RPC should not populate _updatingSubplebbits`, async () => {
            const sub = await plebbit.getSubplebbit({ address: subplebbitAddress });
            const postCid = sub.posts.pages.hot.comments[0].cid;
            const comment = await plebbit.createComment({ cid: postCid });

            expect(Object.keys(plebbit._updatingSubplebbits)).to.deep.equal([]);
            await comment.update();
            await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });

            expect(Object.keys(plebbit._updatingSubplebbits)).to.deep.equal([]);

            await comment.stop();
            expect(Object.keys(plebbit._updatingSubplebbits)).to.deep.equal([]);
        });
    });
});

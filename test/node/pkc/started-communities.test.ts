import {
    itSkipIfRpc,
    mockPKC,
    resolveWhenConditionIsTrue,
    publishRandomPost,
    createSubWithNoChallenge
} from "../../../dist/node/test/test-util.js";
import {
    findStartedCommunity,
    findUpdatingComment,
    findUpdatingCommunity,
    listStartedCommunitys,
    listUpdatingComments,
    listUpdatingCommunitys
} from "../../../dist/node/pkc/tracked-instance-registry-util.js";
import { describe, beforeAll, afterAll, it } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import signers from "../../fixtures/signers.js";

// when it comes to _startedCommunitys with RPC, we need to test it differently
// localCommunity.update() will not use _startedCommunitys, it will create a new subscription and let the RPC server handle the rest
describe.concurrent(`plebbit._startedCommunitys`, () => {
    let plebbit: PKC;
    beforeAll(async () => {
        plebbit = await mockPKC();
    });
    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`sub.start() should add the subplebbit to plebbit._startedCommunitys. stop() should remove it`, async () => {
        const subplebbit = (await plebbit.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        await subplebbit.start();
        expect(findStartedCommunity(plebbit, { address: subplebbit.address })).to.equal(subplebbit);
        await subplebbit.stop();
        expect(findStartedCommunity(plebbit, { address: subplebbit.address })).to.be.undefined;
    });

    it(`started registry resolves the same subplebbit by address, name, publicKey, and sticky aliases`, async () => {
        const isolatedPKC = await mockPKC();

        try {
            const startedCommunity = (await isolatedPKC.createCommunity()) as LocalCommunity | RpcLocalCommunity;
            const originalAddress = startedCommunity.address;
            const aliasBase = `started-sub-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
            const bsoAddress = `${aliasBase}.bso`;
            const ethAddress = `${aliasBase}.eth`;

            await startedCommunity.start();
            await startedCommunity.edit({ address: bsoAddress });
            await new Promise((resolve) => startedCommunity.once("update", resolve));

            const publicKey = startedCommunity.publicKey || startedCommunity.signer.address;

            expect(findStartedCommunity(isolatedPKC, { address: originalAddress })).to.equal(startedCommunity);
            expect(findStartedCommunity(isolatedPKC, { address: bsoAddress })).to.equal(startedCommunity);
            expect(findStartedCommunity(isolatedPKC, { address: ethAddress })).to.equal(startedCommunity);
            expect(findStartedCommunity(isolatedPKC, { name: bsoAddress })).to.equal(startedCommunity);
            expect(findStartedCommunity(isolatedPKC, { publicKey })).to.equal(startedCommunity);
            expect(listStartedCommunitys(isolatedPKC)).to.deep.equal([startedCommunity]);

            await startedCommunity.stop();

            expect(findStartedCommunity(isolatedPKC, { address: originalAddress })).to.be.undefined;
            expect(findStartedCommunity(isolatedPKC, { address: bsoAddress })).to.be.undefined;
            expect(findStartedCommunity(isolatedPKC, { address: ethAddress })).to.be.undefined;
            expect(listStartedCommunitys(isolatedPKC)).to.deep.equal([]);
        } finally {
            await isolatedPKC.destroy().catch(() => {});
        }
    });

    itSkipIfRpc(`localCommunity.update() should use the subplebbit in plebbit._startdCommunitys`, async () => {
        const startedCommunity = (await plebbit.createCommunity()) as LocalCommunity;
        await startedCommunity.start();
        const updateListenersBeforeUpdate = startedCommunity.listeners("update").length;

        const updatingCommunity = (await plebbit.createCommunity({ address: startedCommunity.address })) as LocalCommunity;
        await updatingCommunity.update();
        await resolveWhenConditionIsTrue({ toUpdate: updatingCommunity, predicate: async () => Boolean(updatingCommunity.updatedAt) });
        expect(updatingCommunity.address).to.equal(startedCommunity.address);

        expect(startedCommunity.listeners("update").length).to.be.greaterThan(updateListenersBeforeUpdate); // should use the subplebbit in plebbit._startedCommunitys

        await updatingCommunity.stop();
        expect(startedCommunity.listeners("update").length).to.equal(updateListenersBeforeUpdate); // should not use the subplebbit in plebbit._startedCommunitys

        expect(plebbit._startedCommunitys[startedCommunity.address]).to.exist;
    });

    itSkipIfRpc(`localCommunity.update() should switch to loading from DB if the started subplebbit stops running`, async () => {
        const anotherPKCInstance = await mockPKC();
        const startedCommunity = (await anotherPKCInstance.createCommunity()) as LocalCommunity;
        await startedCommunity.start();

        const updatingCommunity = (await anotherPKCInstance.createCommunity({
            address: startedCommunity.address
        })) as LocalCommunity;
        await updatingCommunity.update();
        await resolveWhenConditionIsTrue({ toUpdate: updatingCommunity, predicate: async () => Boolean(updatingCommunity.updatedAt) });
        expect((updatingCommunity as LocalCommunity)["_mirroredStartedOrUpdatingCommunity"]?.subplebbit.address).to.equal(
            startedCommunity.address
        );
        expect(updatingCommunity.address).to.equal(startedCommunity.address);
        expect(anotherPKCInstance._updatingCommunitys[startedCommunity.address]).to.not.exist; // should use the started subplebbit

        // updatingCommunity is using startedCommunity
        // stop startedCommunity
        await startedCommunity.stop();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(anotherPKCInstance._startedCommunitys[startedCommunity.address]).to.not.exist;
        expect((updatingCommunity as LocalCommunity)["_mirroredStartedOrUpdatingCommunity"]?.subplebbit.address).to.not.exist; // should start using DB
        expect(anotherPKCInstance._updatingCommunitys[startedCommunity.address]).to.exist; // should use the db now

        const subToEdit = (await anotherPKCInstance.createCommunity({ address: startedCommunity.address })) as LocalCommunity;
        await subToEdit.edit({ title: "new title" }); // will edit the db

        // wait for updatingCommunity to emit an update with the new edit props
        await resolveWhenConditionIsTrue({
            toUpdate: updatingCommunity,
            predicate: async () => updatingCommunity.title === "new title"
        });
        expect(updatingCommunity.title).to.equal("new title");
        expect(anotherPKCInstance._updatingCommunitys[startedCommunity.address]).to.exist; // should not use the db now

        await anotherPKCInstance.destroy();

        expect(anotherPKCInstance._startedCommunitys[startedCommunity.address]).to.not.exist;
        expect(anotherPKCInstance._updatingCommunitys[startedCommunity.address]).to.not.exist;
    });

    it(`calling subplebbit.delete() will delete the subplebbit from _startedCommunitys`, async () => {
        const sub = (await plebbit.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        await sub.start();
        expect(plebbit._startedCommunitys[sub.address]).to.exist;

        await sub.delete();
        expect(plebbit._startedCommunitys[sub.address]).to.not.exist;
        expect(plebbit._updatingCommunitys[sub.address]).to.not.exist;
    });

    it(`calling subplebbit.delete() on an instance that's updating from running subplebbit will delete the subplebbit from _startedCommunitys`, async () => {
        const sub = (await plebbit.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        await sub.start();
        expect(plebbit._startedCommunitys[sub.address]).to.exist;

        const updatingCommunity = (await plebbit.createCommunity({ address: sub.address })) as LocalCommunity | RpcLocalCommunity;
        await updatingCommunity.update();
        await resolveWhenConditionIsTrue({ toUpdate: updatingCommunity, predicate: async () => Boolean(updatingCommunity.updatedAt) });
        await updatingCommunity.delete();

        expect(plebbit._updatingCommunitys[sub.address]).to.not.exist;
    });

    it(`Publishing/updating via comment should not stop a started subplebbit`, async () => {
        const startedSub = (await createSubWithNoChallenge({}, plebbit)) as LocalCommunity | RpcLocalCommunity;
        await startedSub.start();
        expect(findStartedCommunity(plebbit, { address: startedSub.address })).to.equal(startedSub);

        const post = await publishRandomPost({ communityAddress: startedSub.address, plebbit: plebbit });
        const comment = await plebbit.createComment({ cid: post.cid! });
        await comment.update();
        await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
        expect(findStartedCommunity(plebbit, { address: startedSub.address })).to.equal(startedSub);
        expect(findUpdatingCommunity(plebbit, { address: startedSub.address })).to.be.undefined;
        expect(findUpdatingComment(plebbit, { cid: comment.cid! })).to.exist;

        await comment.stop();
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(findStartedCommunity(plebbit, { address: startedSub.address })).to.equal(startedSub);
        expect(findUpdatingCommunity(plebbit, { address: startedSub.address })).to.be.undefined;
        expect(findUpdatingComment(plebbit, { cid: comment.cid! })).to.not.exist;

        expect(startedSub.state).to.equal("started");
        await startedSub.stop();
        expect(findStartedCommunity(plebbit, { address: startedSub.address })).to.not.exist;
        expect(findUpdatingCommunity(plebbit, { address: startedSub.address })).to.be.undefined;
        expect(findUpdatingComment(plebbit, { cid: comment.cid! })).to.not.exist;
    });

    it(`destroy clears started, updating subplebbit, and updating comment registries without duplicates`, async () => {
        const isolatedPKC = await mockPKC();
        let destroyed = false;

        try {
            const startedCommunity = (await createSubWithNoChallenge({}, isolatedPKC)) as LocalCommunity | RpcLocalCommunity;
            await startedCommunity.start();

            const updatingCommunity = await isolatedPKC.createCommunity({ address: signers[0].address });
            await updatingCommunity.update();
            await resolveWhenConditionIsTrue({
                toUpdate: updatingCommunity,
                predicate: async () => typeof updatingCommunity.updatedAt === "number"
            });

            const comment = await isolatedPKC.createComment({ cid: updatingCommunity.posts.pages.hot.comments[0].cid });
            await comment.update();
            await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });

            expect(listStartedCommunitys(isolatedPKC)).to.have.lengthOf(1);
            expect(listUpdatingCommunitys(isolatedPKC)).to.have.lengthOf(1);
            expect(listUpdatingComments(isolatedPKC).map((trackedComment) => trackedComment.cid)).to.include(comment.cid);

            expect(new Set(listStartedCommunitys(isolatedPKC)).size).to.equal(listStartedCommunitys(isolatedPKC).length);
            expect(new Set(listUpdatingCommunitys(isolatedPKC)).size).to.equal(listUpdatingCommunitys(isolatedPKC).length);
            expect(new Set(listUpdatingComments(isolatedPKC)).size).to.equal(listUpdatingComments(isolatedPKC).length);

            await isolatedPKC.destroy();
            destroyed = true;

            expect(listStartedCommunitys(isolatedPKC)).to.deep.equal([]);
            expect(listUpdatingCommunitys(isolatedPKC)).to.deep.equal([]);
            expect(listUpdatingComments(isolatedPKC)).to.deep.equal([]);
        } finally {
            if (!destroyed) await isolatedPKC.destroy().catch(() => {});
        }
    });
});

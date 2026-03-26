import {
    itSkipIfRpc,
    mockPlebbit,
    resolveWhenConditionIsTrue,
    publishRandomPost,
    createSubWithNoChallenge
} from "../../../dist/node/test/test-util.js";
import {
    findStartedSubplebbit,
    findUpdatingComment,
    findUpdatingSubplebbit,
    listStartedSubplebbits,
    listUpdatingComments,
    listUpdatingSubplebbits
} from "../../../dist/node/plebbit/tracked-instance-registry-util.js";
import { describe, beforeAll, afterAll, it } from "vitest";
import type { Plebbit } from "../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import signers from "../../fixtures/signers.js";

// when it comes to _startedSubplebbits with RPC, we need to test it differently
// localSubplebbit.update() will not use _startedSubplebbits, it will create a new subscription and let the RPC server handle the rest
describe.concurrent(`plebbit._startedSubplebbits`, () => {
    let plebbit: Plebbit;
    beforeAll(async () => {
        plebbit = await mockPlebbit();
    });
    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`sub.start() should add the subplebbit to plebbit._startedSubplebbits. stop() should remove it`, async () => {
        const subplebbit = (await plebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        await subplebbit.start();
        expect(findStartedSubplebbit(plebbit, { address: subplebbit.address })).to.equal(subplebbit);
        await subplebbit.stop();
        expect(findStartedSubplebbit(plebbit, { address: subplebbit.address })).to.be.undefined;
    });

    it(`started registry resolves the same subplebbit by address, name, publicKey, and sticky aliases`, async () => {
        const isolatedPlebbit = await mockPlebbit();

        try {
            const startedSubplebbit = (await isolatedPlebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
            const originalAddress = startedSubplebbit.address;
            const aliasBase = `started-sub-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
            const bsoAddress = `${aliasBase}.bso`;
            const ethAddress = `${aliasBase}.eth`;

            await startedSubplebbit.start();
            await startedSubplebbit.edit({ address: bsoAddress });
            await new Promise((resolve) => startedSubplebbit.once("update", resolve));

            const publicKey = startedSubplebbit.publicKey || startedSubplebbit.signer.address;

            expect(findStartedSubplebbit(isolatedPlebbit, { address: originalAddress })).to.equal(startedSubplebbit);
            expect(findStartedSubplebbit(isolatedPlebbit, { address: bsoAddress })).to.equal(startedSubplebbit);
            expect(findStartedSubplebbit(isolatedPlebbit, { address: ethAddress })).to.equal(startedSubplebbit);
            expect(findStartedSubplebbit(isolatedPlebbit, { name: bsoAddress })).to.equal(startedSubplebbit);
            expect(findStartedSubplebbit(isolatedPlebbit, { publicKey })).to.equal(startedSubplebbit);
            expect(listStartedSubplebbits(isolatedPlebbit)).to.deep.equal([startedSubplebbit]);

            await startedSubplebbit.stop();

            expect(findStartedSubplebbit(isolatedPlebbit, { address: originalAddress })).to.be.undefined;
            expect(findStartedSubplebbit(isolatedPlebbit, { address: bsoAddress })).to.be.undefined;
            expect(findStartedSubplebbit(isolatedPlebbit, { address: ethAddress })).to.be.undefined;
            expect(listStartedSubplebbits(isolatedPlebbit)).to.deep.equal([]);
        } finally {
            await isolatedPlebbit.destroy().catch(() => {});
        }
    });

    itSkipIfRpc(`localSubplebbit.update() should use the subplebbit in plebbit._startdSubplebbits`, async () => {
        const startedSubplebbit = (await plebbit.createSubplebbit()) as LocalSubplebbit;
        await startedSubplebbit.start();
        const updateListenersBeforeUpdate = startedSubplebbit.listeners("update").length;

        const updatingSubplebbit = (await plebbit.createSubplebbit({ address: startedSubplebbit.address })) as LocalSubplebbit;
        await updatingSubplebbit.update();
        await resolveWhenConditionIsTrue({ toUpdate: updatingSubplebbit, predicate: async () => Boolean(updatingSubplebbit.updatedAt) });
        expect(updatingSubplebbit.address).to.equal(startedSubplebbit.address);

        expect(startedSubplebbit.listeners("update").length).to.be.greaterThan(updateListenersBeforeUpdate); // should use the subplebbit in plebbit._startedSubplebbits

        await updatingSubplebbit.stop();
        expect(startedSubplebbit.listeners("update").length).to.equal(updateListenersBeforeUpdate); // should not use the subplebbit in plebbit._startedSubplebbits

        expect(plebbit._startedSubplebbits[startedSubplebbit.address]).to.exist;
    });

    itSkipIfRpc(`localSubplebbit.update() should switch to loading from DB if the started subplebbit stops running`, async () => {
        const anotherPlebbitInstance = await mockPlebbit();
        const startedSubplebbit = (await anotherPlebbitInstance.createSubplebbit()) as LocalSubplebbit;
        await startedSubplebbit.start();

        const updatingSubplebbit = (await anotherPlebbitInstance.createSubplebbit({
            address: startedSubplebbit.address
        })) as LocalSubplebbit;
        await updatingSubplebbit.update();
        await resolveWhenConditionIsTrue({ toUpdate: updatingSubplebbit, predicate: async () => Boolean(updatingSubplebbit.updatedAt) });
        expect((updatingSubplebbit as LocalSubplebbit)["_mirroredStartedOrUpdatingSubplebbit"]?.subplebbit.address).to.equal(
            startedSubplebbit.address
        );
        expect(updatingSubplebbit.address).to.equal(startedSubplebbit.address);
        expect(anotherPlebbitInstance._updatingSubplebbits[startedSubplebbit.address]).to.not.exist; // should use the started subplebbit

        // updatingSubplebbit is using startedSubplebbit
        // stop startedSubplebbit
        await startedSubplebbit.stop();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(anotherPlebbitInstance._startedSubplebbits[startedSubplebbit.address]).to.not.exist;
        expect((updatingSubplebbit as LocalSubplebbit)["_mirroredStartedOrUpdatingSubplebbit"]?.subplebbit.address).to.not.exist; // should start using DB
        expect(anotherPlebbitInstance._updatingSubplebbits[startedSubplebbit.address]).to.exist; // should use the db now

        const subToEdit = (await anotherPlebbitInstance.createSubplebbit({ address: startedSubplebbit.address })) as LocalSubplebbit;
        await subToEdit.edit({ title: "new title" }); // will edit the db

        // wait for updatingSubplebbit to emit an update with the new edit props
        await resolveWhenConditionIsTrue({
            toUpdate: updatingSubplebbit,
            predicate: async () => updatingSubplebbit.title === "new title"
        });
        expect(updatingSubplebbit.title).to.equal("new title");
        expect(anotherPlebbitInstance._updatingSubplebbits[startedSubplebbit.address]).to.exist; // should not use the db now

        await anotherPlebbitInstance.destroy();

        expect(anotherPlebbitInstance._startedSubplebbits[startedSubplebbit.address]).to.not.exist;
        expect(anotherPlebbitInstance._updatingSubplebbits[startedSubplebbit.address]).to.not.exist;
    });

    it(`calling subplebbit.delete() will delete the subplebbit from _startedSubplebbits`, async () => {
        const sub = (await plebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        await sub.start();
        expect(plebbit._startedSubplebbits[sub.address]).to.exist;

        await sub.delete();
        expect(plebbit._startedSubplebbits[sub.address]).to.not.exist;
        expect(plebbit._updatingSubplebbits[sub.address]).to.not.exist;
    });

    it(`calling subplebbit.delete() on an instance that's updating from running subplebbit will delete the subplebbit from _startedSubplebbits`, async () => {
        const sub = (await plebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        await sub.start();
        expect(plebbit._startedSubplebbits[sub.address]).to.exist;

        const updatingSubplebbit = (await plebbit.createSubplebbit({ address: sub.address })) as LocalSubplebbit | RpcLocalSubplebbit;
        await updatingSubplebbit.update();
        await resolveWhenConditionIsTrue({ toUpdate: updatingSubplebbit, predicate: async () => Boolean(updatingSubplebbit.updatedAt) });
        await updatingSubplebbit.delete();

        expect(plebbit._updatingSubplebbits[sub.address]).to.not.exist;
    });

    it(`Publishing/updating via comment should not stop a started subplebbit`, async () => {
        const startedSub = (await createSubWithNoChallenge({}, plebbit)) as LocalSubplebbit | RpcLocalSubplebbit;
        await startedSub.start();
        expect(findStartedSubplebbit(plebbit, { address: startedSub.address })).to.equal(startedSub);

        const post = await publishRandomPost({ communityAddress: startedSub.address, plebbit: plebbit });
        const comment = await plebbit.createComment({ cid: post.cid! });
        await comment.update();
        await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
        expect(findStartedSubplebbit(plebbit, { address: startedSub.address })).to.equal(startedSub);
        expect(findUpdatingSubplebbit(plebbit, { address: startedSub.address })).to.be.undefined;
        expect(findUpdatingComment(plebbit, { cid: comment.cid! })).to.exist;

        await comment.stop();
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(findStartedSubplebbit(plebbit, { address: startedSub.address })).to.equal(startedSub);
        expect(findUpdatingSubplebbit(plebbit, { address: startedSub.address })).to.be.undefined;
        expect(findUpdatingComment(plebbit, { cid: comment.cid! })).to.not.exist;

        expect(startedSub.state).to.equal("started");
        await startedSub.stop();
        expect(findStartedSubplebbit(plebbit, { address: startedSub.address })).to.not.exist;
        expect(findUpdatingSubplebbit(plebbit, { address: startedSub.address })).to.be.undefined;
        expect(findUpdatingComment(plebbit, { cid: comment.cid! })).to.not.exist;
    });

    it(`destroy clears started, updating subplebbit, and updating comment registries without duplicates`, async () => {
        const isolatedPlebbit = await mockPlebbit();
        let destroyed = false;

        try {
            const startedSubplebbit = (await createSubWithNoChallenge({}, isolatedPlebbit)) as LocalSubplebbit | RpcLocalSubplebbit;
            await startedSubplebbit.start();

            const updatingSubplebbit = await isolatedPlebbit.createSubplebbit({ address: signers[0].address });
            await updatingSubplebbit.update();
            await resolveWhenConditionIsTrue({
                toUpdate: updatingSubplebbit,
                predicate: async () => typeof updatingSubplebbit.updatedAt === "number"
            });

            const comment = await isolatedPlebbit.createComment({ cid: updatingSubplebbit.posts.pages.hot.comments[0].cid });
            await comment.update();
            await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });

            expect(listStartedSubplebbits(isolatedPlebbit)).to.have.lengthOf(1);
            expect(listUpdatingSubplebbits(isolatedPlebbit)).to.have.lengthOf(1);
            expect(listUpdatingComments(isolatedPlebbit).map((trackedComment) => trackedComment.cid)).to.include(comment.cid);

            expect(new Set(listStartedSubplebbits(isolatedPlebbit)).size).to.equal(listStartedSubplebbits(isolatedPlebbit).length);
            expect(new Set(listUpdatingSubplebbits(isolatedPlebbit)).size).to.equal(listUpdatingSubplebbits(isolatedPlebbit).length);
            expect(new Set(listUpdatingComments(isolatedPlebbit)).size).to.equal(listUpdatingComments(isolatedPlebbit).length);

            await isolatedPlebbit.destroy();
            destroyed = true;

            expect(listStartedSubplebbits(isolatedPlebbit)).to.deep.equal([]);
            expect(listUpdatingSubplebbits(isolatedPlebbit)).to.deep.equal([]);
            expect(listUpdatingComments(isolatedPlebbit)).to.deep.equal([]);
        } finally {
            if (!destroyed) await isolatedPlebbit.destroy().catch(() => {});
        }
    });
});

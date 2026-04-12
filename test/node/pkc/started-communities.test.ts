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
    listStartedCommunities,
    listUpdatingComments,
    listUpdatingCommunities
} from "../../../dist/node/pkc/tracked-instance-registry-util.js";
import { describe, beforeAll, afterAll, it } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import signers from "../../fixtures/signers.js";

// when it comes to _startedCommunities with RPC, we need to test it differently
// localCommunity.update() will not use _startedCommunities, it will create a new subscription and let the RPC server handle the rest
describe.concurrent(`pkc._startedCommunities`, () => {
    let pkc: PKC;
    beforeAll(async () => {
        pkc = await mockPKC();
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    it(`community.start() should add the community to pkc._startedCommunities. stop() should remove it`, async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        await community.start();
        expect(findStartedCommunity(pkc, { publicKey: community.publicKey, name: community.name })).to.equal(community);
        await community.stop();
        expect(findStartedCommunity(pkc, { publicKey: community.publicKey, name: community.name })).to.be.undefined;
    });

    it(`started registry resolves the same community by address, name, publicKey, and sticky aliases`, async () => {
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

            expect(findStartedCommunity(isolatedPKC, { publicKey: originalAddress })).to.equal(startedCommunity);
            expect(findStartedCommunity(isolatedPKC, { name: bsoAddress })).to.equal(startedCommunity);
            expect(findStartedCommunity(isolatedPKC, { name: ethAddress })).to.equal(startedCommunity);
            expect(findStartedCommunity(isolatedPKC, { name: bsoAddress })).to.equal(startedCommunity);
            expect(findStartedCommunity(isolatedPKC, { publicKey })).to.equal(startedCommunity);
            expect(listStartedCommunities(isolatedPKC)).to.deep.equal([startedCommunity]);

            await startedCommunity.stop();

            expect(findStartedCommunity(isolatedPKC, { publicKey: originalAddress })).to.be.undefined;
            expect(findStartedCommunity(isolatedPKC, { name: bsoAddress })).to.be.undefined;
            expect(findStartedCommunity(isolatedPKC, { name: ethAddress })).to.be.undefined;
            expect(listStartedCommunities(isolatedPKC)).to.deep.equal([]);
        } finally {
            await isolatedPKC.destroy().catch(() => {});
        }
    });

    itSkipIfRpc(`localCommunity.update() should use the community in pkc._startdCommunitys`, async () => {
        const startedCommunity = (await pkc.createCommunity()) as LocalCommunity;
        await startedCommunity.start();
        const updateListenersBeforeUpdate = startedCommunity.listeners("update").length;

        const updatingCommunity = (await pkc.createCommunity({ address: startedCommunity.address })) as LocalCommunity;
        await updatingCommunity.update();
        await resolveWhenConditionIsTrue({ toUpdate: updatingCommunity, predicate: async () => Boolean(updatingCommunity.updatedAt) });
        expect(updatingCommunity.address).to.equal(startedCommunity.address);

        expect(startedCommunity.listeners("update").length).to.be.greaterThan(updateListenersBeforeUpdate); // should use the community in pkc._startedCommunities

        await updatingCommunity.stop();
        expect(startedCommunity.listeners("update").length).to.equal(updateListenersBeforeUpdate); // should not use the community in pkc._startedCommunities

        expect(pkc._startedCommunities[startedCommunity.address]).to.exist;
    });

    itSkipIfRpc(`localCommunity.update() should switch to loading from DB if the started community stops running`, async () => {
        const anotherPKCInstance = await mockPKC();
        const startedCommunity = (await anotherPKCInstance.createCommunity()) as LocalCommunity;
        await startedCommunity.start();

        const updatingCommunity = (await anotherPKCInstance.createCommunity({
            address: startedCommunity.address
        })) as LocalCommunity;
        await updatingCommunity.update();
        await resolveWhenConditionIsTrue({ toUpdate: updatingCommunity, predicate: async () => Boolean(updatingCommunity.updatedAt) });
        expect((updatingCommunity as LocalCommunity)["_mirroredStartedOrUpdatingCommunity"]?.community.address).to.equal(
            startedCommunity.address
        );
        expect(updatingCommunity.address).to.equal(startedCommunity.address);
        expect(anotherPKCInstance._updatingCommunities[startedCommunity.address]).to.not.exist; // should use the started community

        // updatingCommunity is using startedCommunity
        // stop startedCommunity
        await startedCommunity.stop();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(anotherPKCInstance._startedCommunities[startedCommunity.address]).to.not.exist;
        expect((updatingCommunity as LocalCommunity)["_mirroredStartedOrUpdatingCommunity"]?.community.address).to.not.exist; // should start using DB
        expect(anotherPKCInstance._updatingCommunities[startedCommunity.address]).to.exist; // should use the db now

        const subToEdit = (await anotherPKCInstance.createCommunity({ address: startedCommunity.address })) as LocalCommunity;
        await subToEdit.edit({ title: "new title" }); // will edit the db

        // wait for updatingCommunity to emit an update with the new edit props
        await resolveWhenConditionIsTrue({
            toUpdate: updatingCommunity,
            predicate: async () => updatingCommunity.title === "new title"
        });
        expect(updatingCommunity.title).to.equal("new title");
        expect(anotherPKCInstance._updatingCommunities[startedCommunity.address]).to.exist; // should not use the db now

        await anotherPKCInstance.destroy();

        expect(anotherPKCInstance._startedCommunities[startedCommunity.address]).to.not.exist;
        expect(anotherPKCInstance._updatingCommunities[startedCommunity.address]).to.not.exist;
    });

    it(`calling community.delete() will delete the community from _startedCommunities`, async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        await community.start();
        expect(pkc._startedCommunities[community.address]).to.exist;

        await community.delete();
        expect(pkc._startedCommunities[community.address]).to.not.exist;
        expect(pkc._updatingCommunities[community.address]).to.not.exist;
    });

    it(`calling community.delete() on an instance that's updating from running community will delete the community from _startedCommunities`, async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        await community.start();
        expect(pkc._startedCommunities[community.address]).to.exist;

        const updatingCommunity = (await pkc.createCommunity({ address: community.address })) as LocalCommunity | RpcLocalCommunity;
        await updatingCommunity.update();
        await resolveWhenConditionIsTrue({ toUpdate: updatingCommunity, predicate: async () => Boolean(updatingCommunity.updatedAt) });
        await updatingCommunity.delete();

        expect(pkc._updatingCommunities[community.address]).to.not.exist;
    });

    it(`Publishing/updating via comment should not stop a started community`, async () => {
        const startedCommunity = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity | RpcLocalCommunity;
        await startedCommunity.start();
        expect(findStartedCommunity(pkc, { publicKey: startedCommunity.publicKey, name: startedCommunity.name })).to.equal(
            startedCommunity
        );

        const post = await publishRandomPost({ communityAddress: startedCommunity.address, pkc: pkc });
        const comment = await pkc.createComment({ cid: post.cid! });
        await comment.update();
        await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
        expect(findStartedCommunity(pkc, { publicKey: startedCommunity.publicKey, name: startedCommunity.name })).to.equal(
            startedCommunity
        );
        expect(findUpdatingCommunity(pkc, { publicKey: startedCommunity.publicKey, name: startedCommunity.name })).to.be.undefined;
        expect(findUpdatingComment(pkc, { cid: comment.cid! })).to.exist;

        await comment.stop();
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(findStartedCommunity(pkc, { publicKey: startedCommunity.publicKey, name: startedCommunity.name })).to.equal(
            startedCommunity
        );
        expect(findUpdatingCommunity(pkc, { publicKey: startedCommunity.publicKey, name: startedCommunity.name })).to.be.undefined;
        expect(findUpdatingComment(pkc, { cid: comment.cid! })).to.not.exist;

        expect(startedCommunity.state).to.equal("started");
        await startedCommunity.stop();
        expect(findStartedCommunity(pkc, { publicKey: startedCommunity.publicKey, name: startedCommunity.name })).to.not.exist;
        expect(findUpdatingCommunity(pkc, { publicKey: startedCommunity.publicKey, name: startedCommunity.name })).to.be.undefined;
        expect(findUpdatingComment(pkc, { cid: comment.cid! })).to.not.exist;
    });

    it(`destroy clears started, updating community, and updating comment registries without duplicates`, async () => {
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

            expect(listStartedCommunities(isolatedPKC)).to.have.lengthOf(1);
            expect(listUpdatingCommunities(isolatedPKC)).to.have.lengthOf(1);
            expect(listUpdatingComments(isolatedPKC).map((trackedComment) => trackedComment.cid)).to.include(comment.cid);

            expect(new Set(listStartedCommunities(isolatedPKC)).size).to.equal(listStartedCommunities(isolatedPKC).length);
            expect(new Set(listUpdatingCommunities(isolatedPKC)).size).to.equal(listUpdatingCommunities(isolatedPKC).length);
            expect(new Set(listUpdatingComments(isolatedPKC)).size).to.equal(listUpdatingComments(isolatedPKC).length);

            await isolatedPKC.destroy();
            destroyed = true;

            expect(listStartedCommunities(isolatedPKC)).to.deep.equal([]);
            expect(listUpdatingCommunities(isolatedPKC)).to.deep.equal([]);
            expect(listUpdatingComments(isolatedPKC)).to.deep.equal([]);
        } finally {
            if (!destroyed) await isolatedPKC.destroy().catch(() => {});
        }
    });
});

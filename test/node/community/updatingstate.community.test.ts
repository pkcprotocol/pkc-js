import {
    mockPKC,
    publishRandomPost,
    createSubWithNoChallenge,
    itSkipIfRpc,
    itIfRpc,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describe, beforeAll, afterAll, it } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { CommunityUpdatingState } from "../../../dist/node/community/types.js";

describe.concurrent(`subplebbit.updatingState from a local subplebbit`, async () => {
    let plebbit: PKC;
    beforeAll(async () => {
        plebbit = await mockPKC();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`subplebbit.updatingState defaults to stopped`, async () => {
        const createdCommunity = (await plebbit.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        await createdCommunity.start();
        await resolveWhenConditionIsTrue({
            toUpdate: createdCommunity,
            predicate: async () => typeof createdCommunity.updatedAt === "number"
        });
        const subplebbit = await plebbit.getCommunity({ address: createdCommunity.address });
        expect(subplebbit.updatingState).to.equal("stopped");
    });

    itSkipIfRpc(`subplebbit.updatingState emits 'succceeded' when a new update from local sub is retrieved`, async () => {
        const startedCommunity = await createSubWithNoChallenge({}, plebbit);
        await startedCommunity.start();
        await resolveWhenConditionIsTrue({
            toUpdate: startedCommunity,
            predicate: async () => typeof startedCommunity.updatedAt === "number"
        });

        const localUpdatingSub = (await plebbit.createCommunity({ address: startedCommunity.address })) as
            | LocalCommunity
            | RpcLocalCommunity;
        const expectedStates: CommunityUpdatingState[] = ["publishing-ipns", "succeeded", "stopped"];
        const recordedStates: CommunityUpdatingState[] = [];

        localUpdatingSub.on("updatingstatechange", (newState: CommunityUpdatingState) => recordedStates.push(newState));

        await localUpdatingSub.update();
        const updatePromise = new Promise((resolve) => localUpdatingSub.once("update", resolve));

        await publishRandomPost({ communityAddress: localUpdatingSub.address, plebbit: plebbit });
        await updatePromise;
        await localUpdatingSub.stop();
        await startedCommunity.delete();
        expect(recordedStates).to.deep.equal(expectedStates);
    });

    itIfRpc(`localCommunity.updatingState is copied from startedState if we're updating a local sub via rpc`, async () => {
        const startedSub = await createSubWithNoChallenge({}, plebbit);

        const updatingSub = (await plebbit.createCommunity({ address: startedSub.address })) as LocalCommunity | RpcLocalCommunity;

        const startedInstanceStartedStates: string[] = [];
        startedSub.on("startedstatechange", () => startedInstanceStartedStates.push(startedSub.startedState));

        const updatingSubUpdatingStates: CommunityUpdatingState[] = [];
        updatingSub.on("updatingstatechange", () => updatingSubUpdatingStates.push(updatingSub.updatingState));

        const updates: number[] = [];
        updatingSub.on("update", () => updates.push(updates.length));
        await startedSub.start();

        await resolveWhenConditionIsTrue({ toUpdate: startedSub, predicate: async () => Boolean(startedSub.updatedAt) });

        await updatingSub.update();

        await publishRandomPost({ communityAddress: startedSub.address, plebbit: plebbit }); // to trigger an update
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await publishRandomPost({ communityAddress: startedSub.address, plebbit: plebbit });

        await resolveWhenConditionIsTrue({ toUpdate: updatingSub, predicate: async () => updates.length >= 2 });
        await startedSub.delete();

        expect(updatingSubUpdatingStates).to.deep.equal(
            startedInstanceStartedStates.splice(startedInstanceStartedStates.length - updatingSubUpdatingStates.length)
        );
    });
});

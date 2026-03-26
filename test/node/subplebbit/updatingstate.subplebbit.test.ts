import {
    mockPlebbit,
    publishRandomPost,
    createSubWithNoChallenge,
    itSkipIfRpc,
    itIfRpc,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describe, beforeAll, afterAll, it } from "vitest";
import type { Plebbit } from "../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { SubplebbitUpdatingState } from "../../../dist/node/subplebbit/types.js";

describe.concurrent(`subplebbit.updatingState from a local subplebbit`, async () => {
    let plebbit: Plebbit;
    beforeAll(async () => {
        plebbit = await mockPlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`subplebbit.updatingState defaults to stopped`, async () => {
        const createdSubplebbit = (await plebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        await createdSubplebbit.start();
        await resolveWhenConditionIsTrue({
            toUpdate: createdSubplebbit,
            predicate: async () => typeof createdSubplebbit.updatedAt === "number"
        });
        const subplebbit = await plebbit.getSubplebbit({ address: createdSubplebbit.address });
        expect(subplebbit.updatingState).to.equal("stopped");
    });

    itSkipIfRpc(`subplebbit.updatingState emits 'succceeded' when a new update from local sub is retrieved`, async () => {
        const startedSubplebbit = await createSubWithNoChallenge({}, plebbit);
        await startedSubplebbit.start();
        await resolveWhenConditionIsTrue({
            toUpdate: startedSubplebbit,
            predicate: async () => typeof startedSubplebbit.updatedAt === "number"
        });

        const localUpdatingSub = (await plebbit.createSubplebbit({ address: startedSubplebbit.address })) as
            | LocalSubplebbit
            | RpcLocalSubplebbit;
        const expectedStates: SubplebbitUpdatingState[] = ["publishing-ipns", "succeeded", "stopped"];
        const recordedStates: SubplebbitUpdatingState[] = [];

        localUpdatingSub.on("updatingstatechange", (newState: SubplebbitUpdatingState) => recordedStates.push(newState));

        await localUpdatingSub.update();
        const updatePromise = new Promise((resolve) => localUpdatingSub.once("update", resolve));

        await publishRandomPost({ communityAddress: localUpdatingSub.address, plebbit: plebbit });
        await updatePromise;
        await localUpdatingSub.stop();
        await startedSubplebbit.delete();
        expect(recordedStates).to.deep.equal(expectedStates);
    });

    itIfRpc(`localSubplebbit.updatingState is copied from startedState if we're updating a local sub via rpc`, async () => {
        const startedSub = await createSubWithNoChallenge({}, plebbit);

        const updatingSub = (await plebbit.createSubplebbit({ address: startedSub.address })) as LocalSubplebbit | RpcLocalSubplebbit;

        const startedInstanceStartedStates: string[] = [];
        startedSub.on("startedstatechange", () => startedInstanceStartedStates.push(startedSub.startedState));

        const updatingSubUpdatingStates: SubplebbitUpdatingState[] = [];
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

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

describe.concurrent(`community.updatingState from a local community`, async () => {
    let pkc: PKC;
    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`community.updatingState defaults to stopped`, async () => {
        const createdCommunity = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        await createdCommunity.start();
        await resolveWhenConditionIsTrue({
            toUpdate: createdCommunity,
            predicate: async () => typeof createdCommunity.updatedAt === "number"
        });
        const community = await pkc.getCommunity({ address: createdCommunity.address });
        expect(community.updatingState).to.equal("stopped");
    });

    itSkipIfRpc(`community.updatingState emits 'succceeded' when a new update from local sub is retrieved`, async () => {
        const startedCommunity = await createSubWithNoChallenge({}, pkc);
        await startedCommunity.start();
        await resolveWhenConditionIsTrue({
            toUpdate: startedCommunity,
            predicate: async () => typeof startedCommunity.updatedAt === "number"
        });

        const localUpdatingSub = (await pkc.createCommunity({ address: startedCommunity.address })) as LocalCommunity | RpcLocalCommunity;
        const expectedStates: CommunityUpdatingState[] = ["publishing-ipns", "succeeded", "stopped"];
        const recordedStates: CommunityUpdatingState[] = [];

        localUpdatingSub.on("updatingstatechange", (newState: CommunityUpdatingState) => recordedStates.push(newState));

        await localUpdatingSub.update();
        const updatePromise = new Promise((resolve) => localUpdatingSub.once("update", resolve));

        await publishRandomPost({ communityAddress: localUpdatingSub.address, pkc: pkc });
        await updatePromise;
        await localUpdatingSub.stop();
        await startedCommunity.delete();
        expect(recordedStates).to.deep.equal(expectedStates);
    });

    itIfRpc(`localCommunity.updatingState is copied from startedState if we're updating a local community via rpc`, async () => {
        const startedCommunity = await createSubWithNoChallenge({}, pkc);

        const updatingCommunity = (await pkc.createCommunity({ address: startedCommunity.address })) as LocalCommunity | RpcLocalCommunity;

        const startedInstanceStartedStates: string[] = [];
        startedCommunity.on("startedstatechange", () => startedInstanceStartedStates.push(startedCommunity.startedState));

        const updatingSubUpdatingStates: CommunityUpdatingState[] = [];
        updatingCommunity.on("updatingstatechange", () => updatingSubUpdatingStates.push(updatingCommunity.updatingState));

        const updates: number[] = [];
        updatingCommunity.on("update", () => updates.push(updates.length));
        await startedCommunity.start();

        await resolveWhenConditionIsTrue({ toUpdate: startedCommunity, predicate: async () => Boolean(startedCommunity.updatedAt) });

        await updatingCommunity.update();

        await publishRandomPost({ communityAddress: startedCommunity.address, pkc: pkc }); // to trigger an update
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await publishRandomPost({ communityAddress: startedCommunity.address, pkc: pkc });

        await resolveWhenConditionIsTrue({ toUpdate: updatingCommunity, predicate: async () => updates.length >= 2 });
        await startedCommunity.delete();

        expect(updatingSubUpdatingStates).to.deep.equal(
            startedInstanceStartedStates.splice(startedInstanceStartedStates.length - updatingSubUpdatingStates.length)
        );
    });
});

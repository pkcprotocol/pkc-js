import { beforeAll, afterAll, describe, it } from "vitest";
import {
    mockPKC,
    publishRandomPost,
    createSubWithNoChallenge,
    itSkipIfRpc,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

describe(`subplebbit.startedState`, async () => {
    let plebbit: PKC;
    let subplebbit: LocalCommunity | RpcLocalCommunity;
    beforeAll(async () => {
        plebbit = await mockPKC();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
    });

    it(`subplebbit.startedState defaults to stopped`, async () => {
        expect(subplebbit.startedState).to.equal("stopped");
    });

    it(`subplebbit.startedState is in correct order up to publishing a new IPNS`, async () => {
        const expectedStates = ["publishing-ipns", "succeeded"];
        const recordedStates: string[] = [];
        subplebbit.on("startedstatechange", (newState) => recordedStates.push(newState));

        await subplebbit.start();

        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => Boolean(subplebbit.updatedAt) });
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () => recordedStates.length === 2,
            eventName: "startedstatechange"
        });
        expect(recordedStates).to.deep.equal(expectedStates);
    });

    itSkipIfRpc(`subplebbit.startedState = failed if a failure occurs`, async () => {
        const localSub = subplebbit as LocalCommunity;
        // @ts-expect-error _getDbInternalState is private but we need to mock it for testing
        const originalFunction = localSub._getDbInternalState.bind(localSub);
        // @ts-expect-error _getDbInternalState is private but we need to mock it for testing
        localSub._getDbInternalState = async () => {
            throw Error("Failed to load sub from db ");
        };
        await publishRandomPost({ communityAddress: subplebbit.address, plebbit: plebbit });
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () => subplebbit.startedState === "failed",
            eventName: "startedstatechange"
        });
        expect(subplebbit.startedState).to.equal("failed");
        // @ts-expect-error _getDbInternalState is private but we need to restore it for testing
        localSub._getDbInternalState = originalFunction;
    });
});

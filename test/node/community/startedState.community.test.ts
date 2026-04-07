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

describe(`community.startedState`, async () => {
    let pkc: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    beforeAll(async () => {
        pkc = await mockPKC();
        community = await createSubWithNoChallenge({}, pkc);
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it(`community.startedState defaults to stopped`, async () => {
        expect(community.startedState).to.equal("stopped");
    });

    it(`community.startedState is in correct order up to publishing a new IPNS`, async () => {
        const expectedStates = ["publishing-ipns", "succeeded"];
        const recordedStates: string[] = [];
        community.on("startedstatechange", (newState) => recordedStates.push(newState));

        await community.start();

        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => Boolean(community.updatedAt) });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => recordedStates.length === 2,
            eventName: "startedstatechange"
        });
        expect(recordedStates).to.deep.equal(expectedStates);
    });

    itSkipIfRpc(`community.startedState = failed if a failure occurs`, async () => {
        const localCommunity = community as LocalCommunity;
        // @ts-expect-error _getDbInternalState is private but we need to mock it for testing
        const originalFunction = localCommunity._getDbInternalState.bind(localCommunity);
        // @ts-expect-error _getDbInternalState is private but we need to mock it for testing
        localCommunity._getDbInternalState = async () => {
            throw Error("Failed to load sub from db ");
        };
        await publishRandomPost({ communityAddress: community.address, pkc: pkc });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.startedState === "failed",
            eventName: "startedstatechange"
        });
        expect(community.startedState).to.equal("failed");
        // @ts-expect-error _getDbInternalState is private but we need to restore it for testing
        localCommunity._getDbInternalState = originalFunction;
    });
});

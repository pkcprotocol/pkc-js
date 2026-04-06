import {
    mockPKC,
    createSubWithNoChallenge,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";

describe.concurrent(`subplebbit.features.safeForWork`, async () => {
    let plebbit: PKC;
    let remotePKC: PKC;
    let subplebbit: LocalCommunity | RpcLocalCommunity;

    beforeAll(async () => {
        plebbit = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePKC.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        expect(subplebbit.features).to.be.undefined;
        await subplebbit.edit({ features: { ...subplebbit.features, safeForWork: true } });
        expect(subplebbit.features?.safeForWork).to.be.true;

        const remoteSub = await remotePKC.getCommunity({ address: subplebbit.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({ toUpdate: remoteSub, predicate: async () => remoteSub.features?.safeForWork === true });
        expect(remoteSub.features?.safeForWork).to.be.true;
        await remoteSub.stop();
    });

    it(`Can toggle safeForWork off`, async () => {
        await subplebbit.edit({ features: { ...subplebbit.features, safeForWork: false } });
        expect(subplebbit.features?.safeForWork).to.be.false;

        const remoteSub = await remotePKC.getCommunity({ address: subplebbit.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({ toUpdate: remoteSub, predicate: async () => remoteSub.features?.safeForWork === false });
        expect(remoteSub.features?.safeForWork).to.be.false;
        await remoteSub.stop();
    });
});

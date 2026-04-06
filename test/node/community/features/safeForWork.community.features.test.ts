import {
    mockPlebbit,
    createSubWithNoChallenge,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/pkc/pkc.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/community/rpc-local-community.js";

describe.concurrent(`subplebbit.features.safeForWork`, async () => {
    let plebbit: Plebbit;
    let remotePlebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        expect(subplebbit.features).to.be.undefined;
        await subplebbit.edit({ features: { ...subplebbit.features, safeForWork: true } });
        expect(subplebbit.features?.safeForWork).to.be.true;

        const remoteSub = await remotePlebbit.getSubplebbit({ address: subplebbit.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({ toUpdate: remoteSub, predicate: async () => remoteSub.features?.safeForWork === true });
        expect(remoteSub.features?.safeForWork).to.be.true;
        await remoteSub.stop();
    });

    it(`Can toggle safeForWork off`, async () => {
        await subplebbit.edit({ features: { ...subplebbit.features, safeForWork: false } });
        expect(subplebbit.features?.safeForWork).to.be.false;

        const remoteSub = await remotePlebbit.getSubplebbit({ address: subplebbit.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({ toUpdate: remoteSub, predicate: async () => remoteSub.features?.safeForWork === false });
        expect(remoteSub.features?.safeForWork).to.be.false;
        await remoteSub.stop();
    });
});

import { mockPlebbit, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { describe, beforeAll, afterAll, it } from "vitest";

import type { Plebbit as PlebbitType } from "../../../dist/node/pkc/pkc.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/community/rpc-local-community.js";

describe.concurrent(`Subplebbit.updateCid`, async () => {
    let plebbit: PlebbitType;
    beforeAll(async () => {
        plebbit = await mockPlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`subplebbit.updateCid gets updated when local-subplebbit publishes a new record`, async () => {
        const sub = (await plebbit.createSubplebbit({})) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(sub.updateCid).to.be.undefined;

        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" }); // wait until we publish a new record
        expect(sub.updateCid).to.be.a("string");

        await sub.delete();
    });
    it(`subplebbit.updateCid is defined when creating an instance of an existing local subplebbit`, async () => {
        const sub = (await plebbit.createSubplebbit({})) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(sub.updateCid).to.be.undefined;

        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" }); // wait until we publish a new record
        expect(sub.updateCid).to.be.a("string");

        const recreatedSub = (await plebbit.createSubplebbit({ address: sub.address })) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(recreatedSub.updateCid).to.equal(sub.updateCid);

        await sub.delete();
    });

    it(`subplebbit.updateCid is part of subplebbit.toJSON()`, async () => {
        const sub = (await plebbit.createSubplebbit({})) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(sub.updateCid).to.be.undefined;

        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" }); // wait until we publish a new record

        const subJson = JSON.parse(JSON.stringify(sub));
        expect(subJson.updateCid).to.be.a("string");
        await sub.delete();
    });
});

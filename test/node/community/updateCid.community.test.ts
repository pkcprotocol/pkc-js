import { mockPKC, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { describe, beforeAll, afterAll, it } from "vitest";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

describe.concurrent(`Community.updateCid`, async () => {
    let pkc: PKCType;
    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`community.updateCid gets updated when local-community publishes a new record`, async () => {
        const sub = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
        expect(sub.updateCid).to.be.undefined;

        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" }); // wait until we publish a new record
        expect(sub.updateCid).to.be.a("string");

        await sub.delete();
    });
    it(`community.updateCid is defined when creating an instance of an existing local community`, async () => {
        const sub = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
        expect(sub.updateCid).to.be.undefined;

        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" }); // wait until we publish a new record
        expect(sub.updateCid).to.be.a("string");

        const recreatedSub = (await pkc.createCommunity({ address: sub.address })) as LocalCommunity | RpcLocalCommunity;
        expect(recreatedSub.updateCid).to.equal(sub.updateCid);

        await sub.delete();
    });

    it(`community.updateCid is part of community.toJSON()`, async () => {
        const sub = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
        expect(sub.updateCid).to.be.undefined;

        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" }); // wait until we publish a new record

        const subJson = JSON.parse(JSON.stringify(sub));
        expect(subJson.updateCid).to.be.a("string");
        await sub.delete();
    });
});

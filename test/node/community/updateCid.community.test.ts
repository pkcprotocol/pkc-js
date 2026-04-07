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
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
        expect(community.updateCid).to.be.undefined;

        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" }); // wait until we publish a new record
        expect(community.updateCid).to.be.a("string");

        await community.delete();
    });
    it(`community.updateCid is defined when creating an instance of an existing local community`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
        expect(community.updateCid).to.be.undefined;

        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" }); // wait until we publish a new record
        expect(community.updateCid).to.be.a("string");

        const recreatedCommunity = (await pkc.createCommunity({ address: community.address })) as LocalCommunity | RpcLocalCommunity;
        expect(recreatedCommunity.updateCid).to.equal(community.updateCid);

        await community.delete();
    });

    it(`community.updateCid is part of community.toJSON()`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
        expect(community.updateCid).to.be.undefined;

        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" }); // wait until we publish a new record

        const communityJson = JSON.parse(JSON.stringify(community));
        expect(communityJson.updateCid).to.be.a("string");
        await community.delete();
    });
});

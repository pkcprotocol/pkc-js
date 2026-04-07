import {
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue,
    createMockedCommunityIpns
} from "../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

getAvailablePKCConfigsToTestAgainst().map((config) =>
    describe(`community.updateCid (Remote) - ${config.name}`, async () => {
        let pkc: PKCType;
        let communityAddress: string;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            const ipnsObj = await createMockedCommunityIpns({});
            communityAddress = ipnsObj.communityAddress;
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`community.updateCid is defined after first update event`, async () => {
            const community = await pkc.createCommunity({ address: communityAddress });
            expect(community.updateCid).to.be.undefined;

            await community.update();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            expect(community.updateCid).to.be.a("string");

            await community.stop();
        });

        it(`community.updateCid is defined after pkc.getCommunity`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            expect(community.updateCid).to.be.a("string");
        });

        it(`community.updateCid is part of community.toJSON()`, async () => {
            const communityJson = JSON.parse(JSON.stringify(await pkc.getCommunity({ address: communityAddress })));
            expect(communityJson.updateCid).to.be.a("string");
        });
    })
);

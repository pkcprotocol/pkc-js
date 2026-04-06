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
        let subAddress: string;

        beforeAll(async () => {
            pkc = await config.plebbitInstancePromise();
            const ipnsObj = await createMockedCommunityIpns({});
            subAddress = ipnsObj.communityAddress;
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`community.updateCid is defined after first update event`, async () => {
            const sub = await pkc.createCommunity({ address: subAddress });
            expect(sub.updateCid).to.be.undefined;

            await sub.update();
            await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
            expect(sub.updateCid).to.be.a("string");

            await sub.stop();
        });

        it(`community.updateCid is defined after pkc.getCommunity`, async () => {
            const sub = await pkc.getCommunity({ address: subAddress });
            expect(sub.updateCid).to.be.a("string");
        });

        it(`community.updateCid is part of community.toJSON()`, async () => {
            const subJson = JSON.parse(JSON.stringify(await pkc.getCommunity({ address: subAddress })));
            expect(subJson.updateCid).to.be.a("string");
        });
    })
);

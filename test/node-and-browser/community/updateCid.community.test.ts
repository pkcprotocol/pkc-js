import {
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue,
    createMockedCommunityIpns
} from "../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

getAvailablePKCConfigsToTestAgainst().map((config) =>
    describe(`subplebbit.updateCid (Remote) - ${config.name}`, async () => {
        let plebbit: PKCType;
        let subAddress: string;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            const ipnsObj = await createMockedCommunityIpns({});
            subAddress = ipnsObj.communityAddress;
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`subplebbit.updateCid is defined after first update event`, async () => {
            const sub = await plebbit.createCommunity({ address: subAddress });
            expect(sub.updateCid).to.be.undefined;

            await sub.update();
            await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
            expect(sub.updateCid).to.be.a("string");

            await sub.stop();
        });

        it(`subplebbit.updateCid is defined after plebbit.getCommunity`, async () => {
            const sub = await plebbit.getCommunity({ address: subAddress });
            expect(sub.updateCid).to.be.a("string");
        });

        it(`subplebbit.updateCid is part of subplebbit.toJSON()`, async () => {
            const subJson = JSON.parse(JSON.stringify(await plebbit.getCommunity({ address: subAddress })));
            expect(subJson.updateCid).to.be.a("string");
        });
    })
);

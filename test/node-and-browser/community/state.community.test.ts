import { getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";
import signers from "../../fixtures/signers.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import { expect } from "vitest";

const communityAddress = signers[0].address;
getAvailablePKCConfigsToTestAgainst().map((config) => {
    let pkc: PKCType;
    describe(`community.state - ${config.name}`, () => {
        beforeEach(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterEach(async () => {
            try {
                await pkc.destroy();
            } catch {}
        });

        it(`community.state is stopped when created`, async () => {
            const community = await pkc.createCommunity({ address: communityAddress });
            expect(community.state).to.equal("stopped");
        });

        it(`community.state is stopped when pkc.destroy() is called`, async () => {
            const community = await pkc.createCommunity({ address: communityAddress });
            await community.update();
            await pkc.destroy();
            expect(community.state).to.equal("stopped");
        });

        it(`community.state is updating when updating`, async () => {
            const community = await pkc.createCommunity({ address: communityAddress });
            await community.update();
            expect(community.state).to.equal("updating");
        });

        it(`community.state is stopped when community.stop() is called`, async () => {
            const community = await pkc.createCommunity({ address: communityAddress });
            await community.update();
            expect(community.state).to.equal("updating");
            await community.stop();
            expect(community.state).to.equal("stopped");
        });

        it(`community.state is updating if we're mirroring an updating community`, async () => {
            const community = await pkc.createCommunity({ address: communityAddress });
            await community.update();
            expect(community.state).to.equal("updating");

            const community2 = await pkc.createCommunity({ address: communityAddress });
            await community2.update();
            expect(community2.state).to.equal("updating");

            await community2.stop();
            expect(community2.state).to.equal("stopped");
            expect(community.state).to.equal("updating");

            await community.stop();
            expect(community.state).to.equal("stopped");
            expect(community2.state).to.equal("stopped");
        });
    });
});

import { getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";
import signers from "../../fixtures/signers.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

const communityAddress = signers[0].address;
getAvailablePKCConfigsToTestAgainst().map((config) => {
    let pkc: PKCType;
    describe(`community.state - ${config.name}`, () => {
        beforeEach(async () => {
            pkc = await config.plebbitInstancePromise();
        });

        afterEach(async () => {
            try {
                await pkc.destroy();
            } catch {}
        });

        it(`community.state is stopped when created`, async () => {
            const sub = await pkc.createCommunity({ address: communityAddress });
            expect(sub.state).to.equal("stopped");
        });

        it(`community.state is stopped when pkc.destroy() is called`, async () => {
            const sub = await pkc.createCommunity({ address: communityAddress });
            await sub.update();
            await pkc.destroy();
            expect(sub.state).to.equal("stopped");
        });

        it(`community.state is updating when updating`, async () => {
            const sub = await pkc.createCommunity({ address: communityAddress });
            await sub.update();
            expect(sub.state).to.equal("updating");
        });

        it(`community.state is stopped when community.stop() is called`, async () => {
            const sub = await pkc.createCommunity({ address: communityAddress });
            await sub.update();
            expect(sub.state).to.equal("updating");
            await sub.stop();
            expect(sub.state).to.equal("stopped");
        });

        it(`community.state is updating if we're mirroring an updating community`, async () => {
            const sub = await pkc.createCommunity({ address: communityAddress });
            await sub.update();
            expect(sub.state).to.equal("updating");

            const sub2 = await pkc.createCommunity({ address: communityAddress });
            await sub2.update();
            expect(sub2.state).to.equal("updating");

            await sub2.stop();
            expect(sub2.state).to.equal("stopped");
            expect(sub.state).to.equal("updating");

            await sub.stop();
            expect(sub.state).to.equal("stopped");
            expect(sub2.state).to.equal("stopped");
        });
    });
});

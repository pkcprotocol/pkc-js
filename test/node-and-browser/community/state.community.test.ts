import { getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";
import signers from "../../fixtures/signers.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

const subplebbitAddress = signers[0].address;
getAvailablePKCConfigsToTestAgainst().map((config) => {
    let plebbit: PKCType;
    describe(`subplebbit.state - ${config.name}`, () => {
        beforeEach(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterEach(async () => {
            try {
                await plebbit.destroy();
            } catch {}
        });

        it(`subplebbit.state is stopped when created`, async () => {
            const sub = await plebbit.createCommunity({ address: subplebbitAddress });
            expect(sub.state).to.equal("stopped");
        });

        it(`subplebbit.state is stopped when plebbit.destroy() is called`, async () => {
            const sub = await plebbit.createCommunity({ address: subplebbitAddress });
            await sub.update();
            await plebbit.destroy();
            expect(sub.state).to.equal("stopped");
        });

        it(`subplebbit.state is updating when updating`, async () => {
            const sub = await plebbit.createCommunity({ address: subplebbitAddress });
            await sub.update();
            expect(sub.state).to.equal("updating");
        });

        it(`subplebbit.state is stopped when subplebbit.stop() is called`, async () => {
            const sub = await plebbit.createCommunity({ address: subplebbitAddress });
            await sub.update();
            expect(sub.state).to.equal("updating");
            await sub.stop();
            expect(sub.state).to.equal("stopped");
        });

        it(`subplebbit.state is updating if we're mirroring an updating subplebbit`, async () => {
            const sub = await plebbit.createCommunity({ address: subplebbitAddress });
            await sub.update();
            expect(sub.state).to.equal("updating");

            const sub2 = await plebbit.createCommunity({ address: subplebbitAddress });
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

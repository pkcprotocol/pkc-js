import { beforeAll, afterAll, describe, it } from "vitest";
import { mockPKC, createSubWithNoChallenge } from "../../../dist/node/test/test-util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

describe(`subplebbit.state`, async () => {
    let plebbit: PKC;
    let subplebbit: LocalCommunity | RpcLocalCommunity;
    beforeAll(async () => {
        plebbit = await mockPKC();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
    });

    it(`subplebbit.state defaults to "stopped" if not updating or started`, async () => {
        expect(subplebbit.state).to.equal("stopped");
    });

    it(`subplebbit.state = started if calling start()`, async () => {
        let eventFired = false;
        subplebbit.on("statechange", (newState) => {
            if (newState === "started") eventFired = true;
        });
        await subplebbit.start();
        expect(subplebbit.state).to.equal("started");
        expect(eventFired).to.be.true;
    });

    it(`subplebbit.state = stopped after calling stop()`, async () => {
        let eventFired = false;
        subplebbit.once("statechange", (newState) => {
            expect(newState).to.equal("stopped");
            eventFired = true;
        });
        await subplebbit.stop();
        expect(subplebbit.state).to.equal("stopped");
        expect(eventFired).to.be.true;
    });

    it(`subplebbit.state = updating after calling update()`, async () => {
        let eventFired = false;
        subplebbit.once("statechange", (newState) => {
            expect(newState).to.equal("updating");
            eventFired = true;
        });
        await subplebbit.update();
        expect(subplebbit.state).to.equal("updating");
        expect(eventFired).to.be.true;
    });

    it(`calling update() on a started subplebbit will throw`, async () => {
        const startedCommunity = (await plebbit.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        await startedCommunity.start();
        try {
            await startedCommunity.update();
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as PKCError).code).to.equal("ERR_COMMUNITY_ALREADY_STARTED");
        }
        await startedCommunity.delete();
    });
});

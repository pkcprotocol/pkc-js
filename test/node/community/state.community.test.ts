import { beforeAll, afterAll, describe, it } from "vitest";
import { mockPlebbit, createSubWithNoChallenge } from "../../../dist/node/test/test-util.js";
import type { Plebbit } from "../../../dist/node/pkc/pkc.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/community/rpc-local-community.js";
import type { PlebbitError } from "../../../dist/node/pkc-error.js";

describe(`subplebbit.state`, async () => {
    let plebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    beforeAll(async () => {
        plebbit = await mockPlebbit();
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
        const startedSubplebbit = (await plebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        await startedSubplebbit.start();
        try {
            await startedSubplebbit.update();
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as PlebbitError).code).to.equal("ERR_COMMUNITY_ALREADY_STARTED");
        }
        await startedSubplebbit.delete();
    });
});

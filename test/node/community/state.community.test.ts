import { beforeAll, afterAll, describe, it } from "vitest";
import { mockPKC, createSubWithNoChallenge } from "../../../dist/node/test/test-util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

describe(`community.state`, async () => {
    let pkc: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    beforeAll(async () => {
        pkc = await mockPKC();
        community = await createSubWithNoChallenge({}, pkc);
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it(`community.state defaults to "stopped" if not updating or started`, async () => {
        expect(community.state).to.equal("stopped");
    });

    it(`community.state = started if calling start()`, async () => {
        let eventFired = false;
        community.on("statechange", (newState) => {
            if (newState === "started") eventFired = true;
        });
        await community.start();
        expect(community.state).to.equal("started");
        expect(eventFired).to.be.true;
    });

    it(`community.state = stopped after calling stop()`, async () => {
        let eventFired = false;
        community.once("statechange", (newState) => {
            expect(newState).to.equal("stopped");
            eventFired = true;
        });
        await community.stop();
        expect(community.state).to.equal("stopped");
        expect(eventFired).to.be.true;
    });

    it(`community.state = updating after calling update()`, async () => {
        let eventFired = false;
        community.once("statechange", (newState) => {
            expect(newState).to.equal("updating");
            eventFired = true;
        });
        await community.update();
        expect(community.state).to.equal("updating");
        expect(eventFired).to.be.true;
    });

    it(`calling update() on a started community will throw`, async () => {
        const startedCommunity = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
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

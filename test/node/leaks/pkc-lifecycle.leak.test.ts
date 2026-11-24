// Leak suite (#496): creating and destroying a PKC over and over must leave nothing behind.
//
// An app recreates its PKC on a settings change, and every test file creates several. What a
// destroyed PKC leaves behind is process-wide: module-level registries (shared helia nodes, kubo
// clients), sockets, timers, process listeners. So this scenario has no PKC to walk; it checks that
// each destroyed PKC is collectable and that fds and active handles do not grow per cycle.
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import {
    getAvailablePKCConfigsToTestAgainst,
    publishStaticCommunityWithPostInPages,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { measureRepeatedOperation } from "../../helpers/leak-detection.js";

const ITERATIONS = 6;

type StaticFixture = Awaited<ReturnType<typeof publishStaticCommunityWithPostInPages>>;

for (const config of getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true })) {
    describe(`leak: PKC create + destroy - ${config.name}`, () => {
        let fixture: StaticFixture;

        beforeAll(async () => {
            fixture = await publishStaticCommunityWithPostInPages();
        });

        afterAll(async () => {
            await fixture?.ipnsObj.pkc.destroy();
        });

        // Over RPC this is a known leak with no fix yet (#516), hence .fails there: the client's wait for the
        // connection to open leaves its timeout timer running, and that timer keeps the destroyed PKC (and the
        // process) alive for up to 20 s. Remove the .fails once the timer is cleared.
        const itCreateDestroy = config.testConfigCode === "remote-pkc-rpc" ? it.fails : it;
        itCreateDestroy(`create + destroy ${ITERATIONS} times`, async () => {
            const result = await measureRepeatedOperation({
                roots: () => ({ process: { listeners: process.eventNames().map((name) => process.listeners(name as "exit")) } }),
                iterations: ITERATIONS,
                iteration: async () => {
                    const pkc = await config.pkcInstancePromise();
                    await pkc.destroy();
                    return { pkc };
                }
            });
            expect(result).toEqual({
                instancesStillAlive: [],
                containerGrowth: [],
                processResourceGrowth: [],
                abortSignalAnyOnLongLivedSources: []
            });
        });

        it(`create + load a community and a comment + destroy without stopping them ${ITERATIONS} times`, async () => {
            const result = await measureRepeatedOperation({
                roots: () => ({ process: { listeners: process.eventNames().map((name) => process.listeners(name as "exit")) } }),
                iterations: ITERATIONS,
                iteration: async () => {
                    const pkc = await config.pkcInstancePromise();
                    const community = await pkc.createCommunity({ address: fixture.communityAddress });
                    await community.update();
                    await resolveWhenConditionIsTrue({
                        toUpdate: community,
                        predicate: async () => typeof community.updatedAt === "number"
                    });
                    const comment = await pkc.createComment({ cid: fixture.commentCid });
                    await comment.update();
                    await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
                    // No stop(): destroy() must release everything the PKC's instances hold
                    await pkc.destroy();
                    // The PKC itself is not tracked here: libp2p keeps a closed connection's abort listener on an
                    // AbortSignal.timeout(closeTimeout) until that timer fires, and the close error's stack holds the
                    // destroy() caller. Measured: every destroyed libp2p-js PKC is released 5 to 10 s later.
                    return { community, comment };
                }
            });
            expect(result).toEqual({
                instancesStillAlive: [],
                containerGrowth: [],
                processResourceGrowth: [],
                abortSignalAnyOnLongLivedSources: []
            });
        });
    });
}

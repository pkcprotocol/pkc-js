// Leak suite (#496): loading a community or a comment over and over must not grow what the PKC holds.
//
// Each scenario runs a create -> update -> stop (or a one-shot getCommunity) loop against a static
// fixture community published once, so no other suite's publishing drives extra update cycles. It
// runs under every loader available on node (local kubo, remote kubo-rpc, libp2p-js, gateway, and
// the RPC client when the flag is on), since each loader has its own clients, subscriptions and
// timers. See test/helpers/leak-detection.ts for what is measured.
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import {
    getAvailablePKCConfigsToTestAgainst,
    publishStaticCommunityWithPostInPages,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { measureRepeatedOperation } from "../../helpers/leak-detection.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

const ITERATIONS = 10;

type StaticFixture = Awaited<ReturnType<typeof publishStaticCommunityWithPostInPages>>;

for (const config of getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true })) {
    describe(`leak: repeated remote loading - ${config.name}`, () => {
        let pkc: PKCType;
        let fixture: StaticFixture;

        beforeAll(async () => {
            fixture = await publishStaticCommunityWithPostInPages();
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc?.destroy();
            await fixture?.ipnsObj.pkc.destroy();
        });

        it(`createCommunity + update + stop ${ITERATIONS} times`, async () => {
            const result = await measureRepeatedOperation({
                roots: () => ({ pkc }),
                iterations: ITERATIONS,
                iteration: async () => {
                    const community = await pkc.createCommunity({ address: fixture.communityAddress });
                    await community.update();
                    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
                    await community.stop();
                    return { community };
                }
            });
            expect(result).toEqual({ instancesStillAlive: [], containerGrowth: [], processResourceGrowth: [], abortSignalAnyOnLongLivedSources: [] });
        });

        it(`getCommunity ${ITERATIONS} times`, async () => {
            const result = await measureRepeatedOperation({
                roots: () => ({ pkc }),
                iterations: ITERATIONS,
                iteration: async () => {
                    const community = await pkc.getCommunity({ address: fixture.communityAddress });
                    return { community };
                }
            });
            expect(result).toEqual({ instancesStillAlive: [], containerGrowth: [], processResourceGrowth: [], abortSignalAnyOnLongLivedSources: [] });
        });

        it(`createComment + update + stop ${ITERATIONS} times`, async () => {
            const result = await measureRepeatedOperation({
                roots: () => ({ pkc }),
                iterations: ITERATIONS,
                iteration: async () => {
                    const comment = await pkc.createComment({ cid: fixture.commentCid });
                    await comment.update();
                    await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
                    await comment.stop();
                    return { comment };
                }
            });
            expect(result).toEqual({ instancesStillAlive: [], containerGrowth: [], processResourceGrowth: [], abortSignalAnyOnLongLivedSources: [] });
        });
    });
}

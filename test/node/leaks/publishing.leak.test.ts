// Leak suite (#496): publishing over and over must not grow what the PKC holds.
//
// A publisher creates one publication per post, and each publish subscribes to the community's
// pubsub topic, runs a challenge exchange and may refresh the community record in the background.
// #490 leaked one community instance per publish through that background refresh, so the second
// scenario keeps an updating instance of the community in the same PKC, which is the path it took.
//
// Publishes to the test server's shared community (signers[0]). Nothing here asserts states, only
// that publications are collectable and containers do not grow per publish, so the other suites
// publishing there at the same time do not affect it.
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { getAvailablePKCConfigsToTestAgainst, publishRandomPost, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { measureRepeatedOperation } from "../../helpers/leak-detection.js";
import signers from "../../fixtures/signers.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

const ITERATIONS = 6;
const communityAddress = signers[0].address;

for (const config of getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true })) {
    describe(`leak: repeated publishing - ${config.name}`, () => {
        let pkc: PKCType;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc?.destroy();
        });

        it(`publishing ${ITERATIONS} posts`, async () => {
            const result = await measureRepeatedOperation({
                roots: () => ({ pkc }),
                iterations: ITERATIONS,
                iteration: async () => {
                    const post = await publishRandomPost({ communityAddress, pkc });
                    await post.stop();
                    return { post };
                }
            });
            expect(result).toEqual({ instancesStillAlive: [], containerGrowth: [], processResourceGrowth: [] });
        });

        it(`publishing ${ITERATIONS} posts while the same PKC updates the community (#490)`, async () => {
            const community = await pkc.createCommunity({ address: communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            try {
                const result = await measureRepeatedOperation({
                    roots: () => ({ pkc }),
                    iterations: ITERATIONS,
                    iteration: async () => {
                        const post = await publishRandomPost({ communityAddress, pkc });
                        await post.stop();
                        return { post };
                    }
                });
                expect(result).toEqual({ instancesStillAlive: [], containerGrowth: [], processResourceGrowth: [] });
            } finally {
                await community.stop();
            }
        });
    });
}

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
import { describe, beforeAll, afterAll, it, expect, vi } from "vitest";
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

        // #490, third point: a publication served from an instance the same PKC keeps updating used to
        // fire pkc.getCommunity() in the background on every publish. The communityForPublishing cache
        // it checks is only written by the non-RPC network fetch, so over RPC it never became fresh and
        // every publish paid a refresh (and, before the exports fix, leaked an instance). The live
        // instance's own update loop already keeps the record current, so no refresh is needed at all.
        it(`publishing ${ITERATIONS} posts next to an updating instance does not refetch the community (#490)`, async () => {
            const community = await pkc.createCommunity({ address: communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            const getCommunitySpy = vi.spyOn(pkc, "getCommunity");
            try {
                for (let i = 0; i < ITERATIONS; i++) {
                    const post = await publishRandomPost({ communityAddress, pkc });
                    await post.stop();
                }
                expect({ backgroundGetCommunityCalls: getCommunitySpy.mock.calls.length }).toEqual({ backgroundGetCommunityCalls: 0 });
            } finally {
                getCommunitySpy.mockRestore();
                await community.stop();
            }
        });

        // #490: with no live instance, the first publish fetches the community record from the network and
        // the next ones reuse it from the communityForPublishing cache. Only the non-RPC fetch wrote that
        // cache, so an RPC publisher created, updated and stopped a community instance on every publish,
        // blocking each publish until the record arrived.
        it(`publishing with no live instance fetches the community for the first post only (#490)`, async () => {
            pkc._memCaches.communityForPublishing.clear();
            const publishAndSettle = async () => {
                const post = await publishRandomPost({ communityAddress, pkc });
                // A background refresh, if any, has finished before the next publish looks at the cache.
                // post.stop() does not drain it here: Comment.stop() only reaches Publication.stop() while publishing
                await post._backgroundCommunityRefresh;
                await post.stop();
            };
            await publishAndSettle(); // fetches the record (one fetch may call createCommunity more than once)
            const createCommunitySpy = vi.spyOn(pkc, "createCommunity");
            const getCommunitySpy = vi.spyOn(pkc, "getCommunity");
            try {
                await publishAndSettle();
                await publishAndSettle();
                expect({
                    createCommunityCalls: createCommunitySpy.mock.calls.length,
                    getCommunityCalls: getCommunitySpy.mock.calls.length
                }).toEqual({ createCommunityCalls: 0, getCommunityCalls: 0 });
            } finally {
                createCommunitySpy.mockRestore();
                getCommunitySpy.mockRestore();
            }
        });
    });
}

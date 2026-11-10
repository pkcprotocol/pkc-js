// Leak suite (#496): a LocalCommunity's lifecycle calls must not grow what the PKC holds.
//
// local-community-cycles.leak.test.ts covers a started community's publish cycles. This file covers
// what an owner does around them: stop and start again, edit, create another instance of the same
// community, create and delete a community. Each leaves pubsub subscriptions, db connections, start
// locks, listeners and registry entries that the opposite call must release.
import { beforeAll, afterAll, it, expect } from "vitest";
import {
    createSubWithNoChallenge,
    mockPKC,
    publishRandomPost,
    publishVote,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { unpinStaleCids } from "../../../dist/node/runtime/node/community/local-community/cleanup.js";
import { measureRepeatedOperation } from "../../helpers/leak-detection.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

const ITERATIONS = 6;
const clean: Awaited<ReturnType<typeof measureRepeatedOperation>> = {
    instancesStillAlive: [],
    containerGrowth: [],
    processResourceGrowth: [],
    abortSignalAnyOnLongLivedSources: []
};

// Skipped under RPC: the community and its DbHandler live in the RPC server process, out of reach of
// this process's heap and of the walk. The same LocalCommunity code runs here under local-kubo-rpc.
describeSkipIfRpc("leak: LocalCommunity lifecycle", () => {
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
    });

    afterAll(async () => {
        await community?.delete();
        await pkc?.destroy();
    });

    it(`start + stop ${ITERATIONS} times on one instance`, async () => {
        const result = await measureRepeatedOperation({
            roots: () => ({ pkc, community }),
            iterations: ITERATIONS,
            iteration: async () => {
                const updatedAtBefore = community.updatedAt;
                await community.start();
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => typeof community.updatedAt === "number" && community.updatedAt !== updatedAtBefore
                });
                await community.stop();
                return {};
            }
        });
        expect(result, JSON.stringify(result)).toEqual(clean);
    });

    it(`edit ${ITERATIONS} times while stopped`, async () => {
        const result = await measureRepeatedOperation({
            roots: () => ({ pkc, community }),
            iterations: ITERATIONS,
            iteration: async (i) => {
                await community.edit({ description: `description ${i}` });
                return {};
            }
        });
        expect(result, JSON.stringify(result)).toEqual(clean);
    });

    it(`createCommunity for an existing local community ${ITERATIONS} times`, async () => {
        const result = await measureRepeatedOperation({
            roots: () => ({ pkc, community }),
            iterations: ITERATIONS,
            iteration: async () => {
                const sameCommunity = (await pkc.createCommunity({ address: community.address })) as LocalCommunity;
                return { sameCommunity };
            }
        });
        expect(result, JSON.stringify(result)).toEqual(clean);
    });

    it(`edit ${ITERATIONS} times while started`, async () => {
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        try {
            const result = await measureRepeatedOperation({
                roots: () => ({ pkc, community }),
                iterations: ITERATIONS,
                allowedGrowth: [
                    {
                        path: /\._cidsToUnPin$/,
                        reason: "superseded cids wait out UNPIN_GRACE_PERIOD_MS (30 min, #305) before unpinStaleCids releases them"
                    }
                ],
                iteration: async (i) => {
                    // edit() applies the props to the instance right away; the record that carries them is
                    // published by the next cycle, which is what drains the pending edit
                    await community.edit({ description: `started description ${i}` });
                    await resolveWhenConditionIsTrue({
                        toUpdate: community,
                        predicate: async () => community._pendingEditProps.length === 0
                    });
                    return {};
                }
            });
            expect(result, JSON.stringify(result)).toEqual(clean);
        } finally {
            await community.stop();
        }
    });

    it(`create + start + delete a community ${ITERATIONS} times`, async () => {
        const result = await measureRepeatedOperation({
            roots: () => ({ pkc }),
            iterations: ITERATIONS,
            iteration: async () => {
                const temporary = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
                await temporary.start();
                await resolveWhenConditionIsTrue({ toUpdate: temporary, predicate: async () => typeof temporary.updatedAt === "number" });
                await temporary.delete();
                return { temporary };
            }
        });
        expect(result, JSON.stringify(result)).toEqual(clean);
    });

    // An updating instance of a community that is started elsewhere in the process mirrors the started
    // instance's internal state on every update, including its unpin queue. The started instance drains
    // that queue (after the #305 grace period); the mirror only ever adds to its own copy.
    // it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
    // starts failing once the leak is fixed: remove the .fails then.
    it.fails(`an updating mirror of a started community does not keep cids the started instance already unpinned`, async () => {
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        const mirror = (await pkc.createCommunity({ address: community.address })) as LocalCommunity;
        await mirror.update();
        try {
            const post = await publishRandomPost({ communityAddress: community.address, pkc });
            await post.stop();
            for (let i = 0; i < ITERATIONS; i++) {
                const updatedAtBefore = community.updatedAt!;
                const vote = await publishVote({ commentCid: post.cid!, communityAddress: community.address, vote: 1, pkc });
                await vote.stop();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.updatedAt! > updatedAtBefore });
            }
            expect(mirror._cidsToUnPin.size).toBeGreaterThan(0); // the mirror did follow the queue
            await unpinStaleCids(community, { bypassGracePeriod: true });
            const queuedOnStarted = community._cidsToUnPin.size;
            // One more record, so the mirror takes the started instance's state again
            const updatedAtBefore = community.updatedAt!;
            await community.edit({ description: "after the unpin" });
            await resolveWhenConditionIsTrue({ toUpdate: mirror, predicate: async () => mirror.updatedAt! > updatedAtBefore });
            expect({ queuedOnStarted, mirrorHoldsNoMoreThanStarted: mirror._cidsToUnPin.size <= community._cidsToUnPin.size }).toEqual({
                queuedOnStarted: 0,
                mirrorHoldsNoMoreThanStarted: true
            });
        } finally {
            await mirror.stop();
            await community.stop();
        }
    });
});

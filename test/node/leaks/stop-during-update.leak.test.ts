// Leak suite (#496): stop() that lands while update() is still setting up must leave no updating instance.
//
// update() awaits before it tracks the shared updating instance and attaches to it. A stop() issued in
// that window (a view that mounts and unmounts in one tick) finds nothing to detach from, and update()
// then starts a loop for an instance that reports "stopped". Likewise two instances that call update()
// together must share one updating instance, not start one loop each.
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { getAvailablePKCConfigsToTestAgainst, publishStaticCommunityWithPostInPages } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

// it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
// starts failing once the leak is fixed: remove the .fails then.

type StaticFixture = Awaited<ReturnType<typeof publishStaticCommunityWithPostInPages>>;
const settle = () => new Promise((resolve) => setTimeout(resolve, 1000));

// Skipped under RPC: the RPC client has its own version of this race (the subscribe round trip), covered by
// rpc-stop-during-update.leak.rpc.test.ts
describeSkipIfRpc("leak: stop() during update()", () => {
    for (const config of getAvailablePKCConfigsToTestAgainst({
        includeAllPossibleConfigOnEnv: true,
        includeOnlyTheseTests: ["remote-kubo-rpc", "remote-ipfs-gateway"]
    })) {
        describe(config.name, () => {
            let pkc: PKCType;
            let fixture: StaticFixture;

            beforeAll(async () => {
                fixture = await publishStaticCommunityWithPostInPages();
            });
            // A PKC per test: an updating instance one test leaves behind must not hide the next test's
            const withPkc = async (run: () => Promise<void>) => {
                pkc = await config.pkcInstancePromise();
                try {
                    await run();
                } finally {
                    await pkc.destroy();
                }
            };
            afterAll(async () => {
                await fixture?.ipnsObj.pkc.destroy();
            });

            it("community.update() then stop() in the same tick", () =>
                withPkc(async () => {
                    const community = await pkc.createCommunity({ address: fixture.communityAddress });
                    const updating = community.update();
                    await community.stop();
                    await updating.catch(() => {});
                    await settle();
                    expect({ state: community.state, updatingCommunities: pkc._updatingCommunities.size() }).toEqual({
                        state: "stopped",
                        updatingCommunities: 0
                    });
                }));

            it.fails("comment.update() then stop() in the same tick", () =>
                withPkc(async () => {
                    const comment = await pkc.createComment({ cid: fixture.commentCid });
                    const updating = comment.update();
                    await comment.stop();
                    await updating.catch(() => {});
                    await settle();
                    expect({
                        state: comment.state,
                        updatingComments: pkc._updatingComments.size(),
                        updatingCommunities: pkc._updatingCommunities.size()
                    }).toEqual({ state: "stopped", updatingComments: 0, updatingCommunities: 0 });
                })
            );

            it.fails("two instances of one community calling update() together share one updating instance", () =>
                withPkc(async () => {
                    const [a, b] = await Promise.all([
                        pkc.createCommunity({ address: fixture.communityAddress }),
                        pkc.createCommunity({ address: fixture.communityAddress })
                    ]);
                    await Promise.all([a.update(), b.update()]);
                    const whileUpdating = pkc._updatingCommunities.size();
                    await a.stop();
                    await b.stop();
                    await settle();
                    expect({ whileUpdating, afterStop: pkc._updatingCommunities.size() }).toEqual({ whileUpdating: 1, afterStop: 0 });
                })
            );

            it.fails("two instances of one comment calling update() together share one updating instance", () =>
                withPkc(async () => {
                    const [a, b] = await Promise.all([
                        pkc.createComment({ cid: fixture.commentCid }),
                        pkc.createComment({ cid: fixture.commentCid })
                    ]);
                    await Promise.all([a.update(), b.update()]);
                    const whileUpdating = pkc._updatingComments.size();
                    await a.stop();
                    await b.stop();
                    await settle();
                    expect({ whileUpdating, afterStop: pkc._updatingComments.size() }).toEqual({ whileUpdating: 1, afterStop: 0 });
                })
            );
        });
    }
});

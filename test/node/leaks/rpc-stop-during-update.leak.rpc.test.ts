// Leak suite (#496): stop() that lands while an RPC update() is still subscribing must leave no subscription.
//
// A UI mounts and unmounts views quickly, so update() followed by stop() within one RPC round trip is
// ordinary. The updating instance has no subscription id yet when stop() runs, so there is nothing to
// unsubscribe; when the subscribe response then arrives, the id must not be adopted by an instance that
// nobody can reach any more.
import { beforeAll, afterAll, it, expect } from "vitest";
import { describe } from "vitest";
import { mockRpcRemotePKC, publishStaticCommunityWithPostInPages, isRpcFlagOn } from "../../../dist/node/test/test-util.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

// it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
// starts failing once the leak is fixed: remove the .fails then.

type StaticFixture = Awaited<ReturnType<typeof publishStaticCommunityWithPostInPages>>;
type RpcClientInternals = { _subscriptionEvents: Record<string, unknown>; _resubscribeCalls: Map<unknown, unknown> };

const rpcRegistries = (pkc: PKCType) => {
    const client = pkc._pkcRpcClient as unknown as RpcClientInternals;
    return {
        subscriptionEvents: Object.keys(client._subscriptionEvents).length,
        resubscribeCalls: client._resubscribeCalls.size,
        updatingComments: Object.keys(pkc._updatingComments).length,
        updatingCommunities: Object.keys(pkc._updatingCommunities).length
    };
};

// Only meaningful over RPC: the race is between stop() and the RPC subscribe round trip
describe.runIf(isRpcFlagOn())("leak: stop() during an in-flight RPC update()", () => {
    let pkc: PKCType;
    let fixture: StaticFixture;

    beforeAll(async () => {
        fixture = await publishStaticCommunityWithPostInPages();
        pkc = await mockRpcRemotePKC();
    });

    afterAll(async () => {
        await pkc?.destroy();
        await fixture?.ipnsObj.pkc.destroy();
    });

    it.fails("comment.update() then comment.stop() before the subscribe response", async () => {
        const before = rpcRegistries(pkc);
        const comment = await pkc.createComment({ cid: fixture.commentCid });
        const updating = comment.update();
        await comment.stop();
        await updating.catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(rpcRegistries(pkc)).toEqual(before);
    });

    it("community.update() then community.stop() before the subscribe response", async () => {
        const before = rpcRegistries(pkc);
        const community = await pkc.createCommunity({ address: fixture.communityAddress });
        const updating = community.update();
        await community.stop();
        await updating.catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(rpcRegistries(pkc)).toEqual(before);
    });
});

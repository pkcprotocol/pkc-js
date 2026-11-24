// Leak suite (#496): pkc.destroy() must still close storage and the communities watcher when one stop() rejects.
import { expect } from "vitest";
import { mockPKC, publishStaticCommunityWithPostInPages, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { listUpdatingCommunities } from "../../../dist/node/pkc/tracked-instance-registry-util.js";
import { itSkipIfRpc } from "../../helpers/conditional-tests.js";

// it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
// starts failing once the leak is fixed: remove the .fails then.

type PkcInternals = { _communityFsWatchAbort?: AbortController; _storage: { _db: { open: boolean; close: () => void } } };

// Skipped under RPC: an RPC client PKC has no communities watcher (pkc.ts creates it only without
// pkcRpcClientsOptions), so the assertion below could never hold there and .fails would never flip
itSkipIfRpc.fails("kubo with a dataPath: destroy() still closes storage and the fs watcher when a community's stop() rejects", async () => {
    const fixture = await publishStaticCommunityWithPostInPages();
    // stubStorage false: the real sqlite storage is what must be closed
    const pkc = await mockPKC({ dataPath: `.tmp/leak-data-destroy-${Date.now()}` }, false, false);
    const internals = pkc as unknown as PkcInternals;
    try {
        const community = await pkc.createCommunity({ address: fixture.communityAddress });
        await community.update();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        const updating = listUpdatingCommunities(pkc);
        expect(updating.length).toBeGreaterThan(0);
        const originalStop = updating[0].stop.bind(updating[0]);
        updating[0].stop = async () => {
            await originalStop();
            throw new Error("stop failed");
        };

        const firstDestroy = await pkc.destroy().then(
            () => "resolved",
            () => "rejected"
        );
        const secondDestroy = await pkc.destroy().then(
            () => "resolved",
            () => "rejected"
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect({
            fsWatcherAborted: internals._communityFsWatchAbort?.signal.aborted,
            storageDbOpen: internals._storage._db.open
        }).toEqual({ fsWatcherAborted: true, storageDbOpen: false });
    } finally {
        if (internals._communityFsWatchAbort && !internals._communityFsWatchAbort.signal.aborted) internals._communityFsWatchAbort.abort();
        if (internals._storage._db.open) internals._storage._db.close();
        await fixture.ipnsObj.pkc.destroy();
    }
});

// Integration repro for issue #305: superseded community update cids used to be unpinned as soon as
// the next sync ran, so a repo.gc landing right after could delete blocks that a client holding the
// previous update was still fetching (observed in CI as ERR_FETCH_CID_P2P_TIMEOUT on a replies page
// cid). Pinned blocks are exempt from GC by kubo's contract, so the fix keeps superseded cids pinned
// for a grace period; this test asserts the previous generations' update cids are still pinned on
// the community node after later generations have been published and the unpin pass has run.

import { beforeAll, afterAll, describe, expect } from "vitest";
import { mockPKCV2, createSubWithNoChallenge, publishRandomPost, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../helpers/conditional-tests.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

describe("superseded update cids survive the unpin pass (issue #305)", () => {
    let pkc: PKCType;

    beforeAll(async () => {
        pkc = await mockPKCV2();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    // Can't run under RPC: the community then lives in the RPC server's process with its own kubo
    // daemon, and the test needs to pin.ls that daemon directly, which the pkc RPC API does not expose.
    itSkipIfRpc("keeps the previous update cids pinned after later updates supersede them", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        try {
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

            const supersededUpdateCids: string[] = [];

            // Two extra generations: gen1's cid is queued for unpinning while gen2 publishes, and the
            // unpin pass that used to remove it runs at the start of gen3's publish.
            for (let generation = 0; generation < 2; generation++) {
                const updateCidOfCurrentGeneration = community.updateCid;
                if (!updateCidOfCurrentGeneration) throw Error("community.updateCid should be defined after the first update");
                supersededUpdateCids.push(updateCidOfCurrentGeneration);
                await publishRandomPost({ communityAddress: community.address, pkc });
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => typeof community.updateCid === "string" && community.updateCid !== updateCidOfCurrentGeneration
                });
            }

            const kuboRpcUrl = Object.keys(pkc.clients.kuboRpcClients)[0];
            const kuboClient = pkc.clients.kuboRpcClients[kuboRpcUrl]._client;

            for (const supersededUpdateCid of supersededUpdateCids) {
                const pins = [];
                // pin.ls with a path throws "path '<cid>' is not pinned" when the pin is gone
                for await (const pin of kuboClient.pin.ls({ paths: supersededUpdateCid })) pins.push(pin);
                expect(pins.length, `superseded update cid ${supersededUpdateCid} should still be pinned`).to.be.greaterThan(0);
            }
        } finally {
            await community.stop();
        }
    });
});

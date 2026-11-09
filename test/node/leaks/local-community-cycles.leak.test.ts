// Leak suite (#496): a started LocalCommunity must not grow what it holds per publish cycle.
//
// A daemon runs these cycles for weeks, so anything kept per cycle (a prepared statement per cycle
// like #488, an abort listener per loop iteration like #146, a timer, an fd) eventually takes it
// down. Each iteration publishes a post into the community and waits for the cycle that includes
// it; the walk covers the community itself (DbHandler, page generator, update loop state) and the PKC.
import { beforeAll, afterAll, it, expect } from "vitest";
import { createSubWithNoChallenge, mockPKC, publishRandomPost, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { measureRepeatedOperation } from "../../helpers/leak-detection.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

const ITERATIONS = 8;

// Skipped under RPC: the community and its DbHandler live in the RPC server process, out of reach
// of this process's heap and of the walk. The RPC server's own retention is covered by running this
// suite under local-kubo-rpc, which exercises the same LocalCommunity code.
describeSkipIfRpc("leak: LocalCommunity publish cycles", () => {
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        await community?.delete();
        await pkc?.destroy();
    });

    it(`${ITERATIONS} publish cycles, one new post each`, async () => {
        const result = await measureRepeatedOperation({
            roots: () => ({ pkc, community }),
            iterations: ITERATIONS,
            allowedGrowth: [
                {
                    path: /\._cidsToUnPin$/,
                    reason: "superseded cids wait out UNPIN_GRACE_PERIOD_MS (30 min, #305) before unpinStaleCids releases them"
                }
            ],
            iteration: async () => {
                const post = await publishRandomPost({ communityAddress: community.address, pkc });
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => Boolean(community.lastPostCid === post.cid)
                });
                await post.stop();
                return { post };
            }
        });
        expect(result).toEqual({ instancesStillAlive: [], containerGrowth: [], processResourceGrowth: [] });
    });
});

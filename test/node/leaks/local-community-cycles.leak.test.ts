// Leak suite (#496): a started LocalCommunity must not grow what it holds per publish cycle.
//
// A daemon runs these cycles for weeks, so anything kept per cycle (a prepared statement per cycle
// like #488, an abort listener per loop iteration like #146, a timer, an fd) eventually takes it
// down. Each iteration publishes a vote from a fresh author on one fixed post and waits for the next
// cycle. A vote reruns the whole cycle (CommentUpdate calculation, pages, IPNS) without adding an
// entry to the pages, so what the community holds in memory legitimately stays the same size; a new
// post per iteration would grow the preloaded page and read as retention. The walk covers the
// community itself (DbHandler, page generator, update loop state) and the PKC.
import { beforeAll, afterAll, it, expect } from "vitest";
import { createSubWithNoChallenge, mockPKC, publishRandomPost, publishVote, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
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
    let postCid: string;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        const post = await publishRandomPost({ communityAddress: community.address, pkc });
        postCid = post.cid!;
        await post.stop();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.lastPostCid === postCid });
    });

    afterAll(async () => {
        await community?.delete();
        await pkc?.destroy();
    });

    it(`${ITERATIONS} publish cycles, one vote each`, async () => {
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
                const updatedAtBeforeVote = community.updatedAt!;
                const vote = await publishVote({ commentCid: postCid, communityAddress: community.address, vote: 1, pkc });
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.updatedAt! > updatedAtBeforeVote });
                await vote.stop();
                return { vote };
            }
        });
        expect(result).toEqual({ instancesStillAlive: [], containerGrowth: [], processResourceGrowth: [], abortSignalAnyOnLongLivedSources: [] });
    });
});

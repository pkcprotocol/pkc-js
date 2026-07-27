import { mockPKC } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { it, expect, vi } from "vitest";
import { of as calculateIpfsCidV0Lib } from "typestub-ipfs-only-hash";
import { randomUUID } from "node:crypto";
import env from "../../../dist/node/version.js";
import { calculateStringSizeSameAsIpfsAddCidV0 } from "../../../dist/node/util.js";
import { updateCommentsThatNeedToBeUpdated } from "../../../dist/node/runtime/node/community/local-community/comment-updates.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { CommentsTableRowInsert } from "../../../dist/node/publications/comment/types.js";

// Regression test for issue #230.
//
// updateCommentsThatNeedToBeUpdated() stamps every CommentUpdate row it writes with
// batchStartTimestamp — a timestamp captured before the batch's flag query runs (issue #209/#211) —
// while each row's updatedAt is stamped when that row is actually calculated. A post tree is walked
// deepest-depth-first, so a child is always calculated before its parent and the child's updatedAt
// lands later than the batch's start.
//
// The stale_replies CTE in queryCommentsToBeUpdated() compared cu_child.updatedAt against
// cu_parent.insertedAt, so any batch spanning >= 1 second re-flagged every parent whose preloaded
// `best` replies page held a child updated in that same batch. Re-flagging produced another
// >= 1 second batch, which re-flagged again: the loop never converged. A production node was
// re-signing and republishing the same ~291 comments every ~2 minutes with no new votes, edits,
// moderations or replies, and rotating every post's updateCid along with them.
//
// This test drives a real batch whose page generation is slowed past the one-second boundary, then
// asserts the queue drains. Uses LocalCommunity internals (_dbHandler, _pageGenerator) which live
// server-side under RPC and are unreachable from the client, so it cannot run under RPC.
describeSkipIfRpc("update loop converges when a batch spans more than one second (issue #230)", function () {
    it("does not requeue comments that were all recalculated by the same slow batch", async () => {
        const context = await createCommunityWithFakeIpfs();
        try {
            const { community } = context;

            // A chain of replies, so each parent's preloaded `best` page references a child that the
            // same batch recalculates. A chain (rather than one post with several replies) is what
            // makes the batch cross the one-second boundary: updateCommentsThatNeedToBeUpdated
            // processes one depth level at a time and awaits each level, and updatedAt is stamped when
            // a comment's calculation *starts*, so only accumulated work from deeper levels can push a
            // child's updatedAt past the batch's start second. Seeded well in the past so the comment
            // rows themselves never satisfy direct_updates' `child.insertedAt >= cu.insertedAt`.
            const seededAt = Math.floor(Date.now() / 1000) - 3600;
            const chainCids = await seedReplyChain(community, { depth: 4, seededAt });

            const pageGenerator = community._pageGenerator;
            const originalGeneratePostPages = pageGenerator.generatePostPages.bind(pageGenerator);
            const originalGenerateReplyPages = pageGenerator.generateReplyPages.bind(pageGenerator);
            const slowPageGeneration = () => new Promise((resolve) => setTimeout(resolve, 800));

            const postPagesSpy = vi
                .spyOn(pageGenerator, "generatePostPages")
                .mockImplementation(async (...args: Parameters<typeof originalGeneratePostPages>) => {
                    await slowPageGeneration();
                    return originalGeneratePostPages(...args);
                });
            const replyPagesSpy = vi
                .spyOn(pageGenerator, "generateReplyPages")
                .mockImplementation(async (...args: Parameters<typeof originalGenerateReplyPages>) => {
                    await slowPageGeneration();
                    return originalGenerateReplyPages(...args);
                });

            const rows = await updateCommentsThatNeedToBeUpdated(community);
            expect(rows.length, "the batch should have recalculated every comment in the chain").to.equal(chainCids.length);

            const storedUpdates = chainCids.map((cid) => community._dbHandler.queryStoredCommentUpdate({ cid })!);
            const batchInsertedAt = storedUpdates[0].insertedAt;
            expect(
                new Set(storedUpdates.map((update) => update.insertedAt)).size,
                "every row of one batch shares the batch's start timestamp as insertedAt"
            ).to.equal(1);
            // Precondition of the bug: without at least one child stamped in a later second than the
            // batch's start, stale_replies could not fire and the assertion below would pass vacuously.
            expect(
                storedUpdates.filter((update) => update.updatedAt > batchInsertedAt).length,
                "the batch must span at least a second for this test to exercise the bug"
            ).to.be.at.least(1);

            // syncPostUpdatesWithIpfs does this once the updates reach MFS; without it every row stays
            // flagged by direct_updates and the assertion below would pass for the wrong reason.
            community._dbHandler.markCommentsAsPublishedToPostUpdates(rows.map((row) => row.newCommentUpdate.cid));

            const flaggedAfterBatch = community._dbHandler.queryCommentsToBeUpdated().map((comment) => comment.cid);
            expect(
                flaggedAfterBatch,
                "nothing changed since the batch, so the next loop must have no work — a non-empty queue here is the perpetual update loop of issue #230"
            ).to.be.empty;

            postPagesSpy.mockRestore();
            replyPagesSpy.mockRestore();
        } finally {
            await context.cleanup();
        }
    });
});

interface CommunityContext {
    pkc: PKCType;
    community: LocalCommunity;
    cleanup: () => Promise<void>;
}

async function createCommunityWithFakeIpfs(): Promise<CommunityContext> {
    const pkc: PKCType = await mockPKC();
    const community = (await pkc.createCommunity()) as LocalCommunity;
    await community._dbHandler.initDbIfNeeded();
    await community._dbHandler.createOrMigrateTablesIfNeeded();
    vi.spyOn(community._clientsManager, "getDefaultKuboRpcClient").mockReturnValue({
        _client: createFakeIpfsClient()
    } as unknown as ReturnType<typeof community._clientsManager.getDefaultKuboRpcClient>);
    return {
        pkc,
        community,
        cleanup: async () => {
            await community._dbHandler.destoryConnection();
            await community.delete();
            await pkc.destroy();
        }
    };
}

function createFakeIpfsClient() {
    const noopAsync = async (): Promise<void> => {};
    return {
        add: async (content: string) => {
            const size = await calculateStringSizeSameAsIpfsAddCidV0(content);
            const cid = await calculateIpfsCidV0Lib(`${content.length}-${randomUUID()}`);
            return { cid, path: cid, size };
        },
        pin: { rm: noopAsync },
        files: { rm: noopAsync },
        key: { rm: noopAsync },
        routing: {
            async *provide(): AsyncGenerator<never, void, unknown> {
                return;
            }
        }
    };
}

// Seeds a post and a single chain of replies hanging off it: post -> reply -> reply -> ...
// Returned cids are ordered from the post downwards.
async function seedReplyChain(community: LocalCommunity, { depth, seededAt }: { depth: number; seededAt: number }): Promise<string[]> {
    const buildRow = (cid: string, commentDepth: number, parentCid: string | null, postCid: string, timestamp: number) =>
        ({
            cid,
            authorSignerAddress: `12D3KooAuthor-${cid}`,
            author: { address: `12D3KooAuthor-${cid}` },
            parentCid,
            postCid,
            communityPublicKey: community.signer.address,
            content: `content-${cid}`,
            title: commentDepth === 0 ? `title-${cid}` : null,
            timestamp,
            depth: commentDepth,
            signature: { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] },
            protocolVersion: env.PROTOCOL_VERSION,
            pendingApproval: null,
            insertedAt: timestamp
        }) as unknown as CommentsTableRowInsert;

    const cids = await Promise.all(
        Array.from({ length: depth + 1 }, (_, index) => calculateIpfsCidV0Lib(`chain-${index}-${randomUUID()}`))
    );
    const postCid = cids[0];

    community._dbHandler.insertComments(
        cids.map((cid, index) => buildRow(cid, index, index === 0 ? null : cids[index - 1], postCid, seededAt + index))
    );

    return cids;
}

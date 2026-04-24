import {
    createSubWithNoChallenge,
    forceLocalSubPagesToAlwaysGenerateMultipleChunks,
    mockPKC,
    mockPKCV2,
    mockReplyToUseParentPagesForUpdates,
    publishRandomPost,
    publishRandomReply,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentUpdateType, CommentUpdatesRow } from "../../../dist/node/publications/comment/types.js";

// Regression test for https://github.com/pkcprotocol/pkc-js/actions/runs/24832823452.
//
// The CI failure was:
//   test/node/comment/loading.update.test.ts:359
//   "parent replies served via pageCids with depth 1 > loads reply updates when the parent was stopped"
//   Test timed out in 160000ms. Ubuntu + Windows fail, macOS passes.
//
// Root cause (per-test stderr analysis):
//
//   1. The publisher's `LocalCommunity` stops publishing IPNS once content is stable —
//      `_calculateLatestUpdateTrigger` returns false when there are no new posts/replies and
//      `lastPublishTooOld` is a 15-minute threshold (`local-community.ts:689`). With
//      `forceParentRepliesPageCids: true` at depth 1 there are exactly 2 replies after setup
//      and nothing else is published.
//   2. The `local-kubo-rpc` remote PKC mirrors the publisher's community via
//      `processStartedCommunities`. It receives updates **by push** — it does not poll.
//   3. During `replyComment.update()`, the post's `handleUpdateEventFromCommunity` fires its
//      initial fetch of `<ipnsCid>/<postCid>/update` via `_fetchCidP2P`. In the CI run that
//      fetch returned `fetch failed (TypeError)` — an undici socket-level error, not a timeout.
//      Fetch happened twice in quick succession (the page-cid fetch too), both failed.
//   4. `useCommunityPostUpdatesToFetchCommentUpdateForPost` caught the error and set the post
//      to `waiting-retry`, but the retry only fires on the next `handleUpdateEventFromCommunity`
//      invocation — i.e. the next publisher push. Since the publisher has nothing to publish,
//      the retry never fires and the reply hangs.
//   5. macOS passed the same commit, the `remote-kubo-rpc` and `remote-ipfs-gateway` configs
//      passed — both poll IPNS on a timer rather than waiting for a push, so they recover
//      from the same transient failure.
//
// This test reproduces the hang deterministically by:
//   - Running the exact depth-1 + forceParentRepliesPageCids scenario in a sequential describe
//     (no `describe.concurrent` siblings).
//   - Creating a `local-kubo-rpc`-equivalent remote PKC that shares the publisher's dataPath.
//   - Patching the remote PKC's kubo-rpc-client `_client.cat` to raise the same
//     `fetch failed (TypeError)` on the first two fetches fired after `replyComment.update()`
//     — this mirrors the two back-to-back failures seen in the CI stderr at 11:34:57.97x.
//   - Giving the reply a 30-second budget to catch up, instead of 160s.
//
// Expected outcome on master: test fails with the 30s timeout (no retry scheduler).
// After fix: test passes in < 2s because whatever retry mechanism lands must not depend on
// the publisher issuing another push.
describeSkipIfRpc("comment.update: local-kubo-rpc transient fetch failure must not hang reply (depth 1)", () => {
    let publisherPKC: PKC;
    let community: LocalCommunity;
    let rootCid: string;
    let leafCid: string;
    let expectedLeafUpdate: CommentUpdateType;
    let forcedParentStoredUpdate: CommentUpdatesRow;

    beforeAll(async () => {
        publisherPKC = await mockPKC();
        community = (await createSubWithNoChallenge({}, publisherPKC)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });

        const post = await publishRandomPost({ communityAddress: community.address, pkc: publisherPKC });
        rootCid = post.cid!;
        const reply = await publishRandomReply({ parentComment: post as never, pkc: publisherPKC });
        leafCid = reply.cid!;

        // Wait until the reply has a stored CommentUpdate — we need its `updatedAt` as the target.
        expectedLeafUpdate = await waitForStoredCommentUpdate(community, leafCid);

        // Force the post's replies to be served via multi-chunk pageCids (matching the scenario
        // in loading.update.test.ts's `parent replies served via pageCids with depth 1` block).
        const parentComment = await publisherPKC.createComment({ cid: rootCid });
        try {
            await parentComment.update();
            await resolveWhenConditionIsTrue({
                toUpdate: parentComment,
                predicate: async () => typeof parentComment.updatedAt === "number"
            });
            await forceLocalSubPagesToAlwaysGenerateMultipleChunks({ community, parentComment });
            forcedParentStoredUpdate = await waitForStoredParentPageCids(community, rootCid);
        } finally {
            await parentComment.stop();
        }
    });

    afterAll(async () => {
        await community?.delete();
        await publisherPKC?.destroy();
    });

    it("reply recovers within 30s when initial post commentUpdate + page fetches fail transiently", async () => {
        // Pre-conditions mirror the existing failing assertions so this test *only* covers the
        // recovery-after-transient-failure path, not any earlier correctness of the force-chunking setup.
        expect(forcedParentStoredUpdate).toBeDefined();
        expect(forcedParentStoredUpdate.replies).toBeDefined();
        const hasAllPageCids = Object.values(forcedParentStoredUpdate.replies ?? {}).some(
            (s) => (s as { allPageCids?: string[] } | undefined)?.allPageCids?.length
        );
        expect(hasAllPageCids).toBe(true);

        // The essence of the bug: a second PKC using the same kubo endpoint AND the same on-disk
        // dataPath. This makes the remote PKC's LocalCommunity share the publisher's community DB
        // and participate in the mirror/registry protocol against `processStartedCommunities`.
        const remotePKC = await mockPKCV2({
            pkcOptions: {
                kuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
                pubsubKuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
                pkcRpcClientsOptions: undefined,
                ipfsGatewayUrls: undefined,
                dataPath: publisherPKC.dataPath
            }
        });
        // Sanity: verify the shared-dataPath config is actually in effect.
        expect(remotePKC.dataPath).toBe(publisherPKC.dataPath);

        // Inject the failure seen in CI: the first two fetches that touch an MFS path or
        // a `replies.pageCids` entry throw `fetch failed (TypeError)` once. We only want to
        // fail fetches triggered by the reply's update flow — NOT the publisher-side cat
        // calls the test setup may have issued. We therefore install the patch on the
        // remote PKC's `_client.cat` **after** the PKC is created, right before calling
        // `replyComment.update()`, and we leave CommentIpfs fetches alone (plain CIDs that
        // are shorter than an MFS path are allowed through) so the reply / post CommentIpfs
        // loads still succeed — matching the CI timeline where only the postUpdate path
        // and the pageCid fetch failed.
        const kuboRpcUrl = Object.keys(remotePKC.clients.kuboRpcClients)[0];
        const kuboClient = (remotePKC.clients.kuboRpcClients[kuboRpcUrl] as { _client: { cat: Function } })._client;
        const originalCat = kuboClient.cat.bind(kuboClient);
        const pageCidToFail = extractFirstPageCid(forcedParentStoredUpdate);
        expect(pageCidToFail).toBeDefined();
        // Fail each target CID twice — verifies that _fetchCidP2P retries more than once
        // (i.e. the mechanism isn't just "retry once and give up"). _fetchCidP2P uses
        // MAX_ATTEMPTS = 3, so two injected failures + one pass exercises the retry loop.
        const FAIL_ATTEMPTS = 2;
        const failureCountByArg = new Map<string, number>();
        kuboClient.cat = function patchedCat(target: unknown, opts?: unknown): AsyncIterable<Uint8Array> {
            const arg = typeof target === "string" ? target : String(target);
            const isPostUpdateMfsPath = arg.includes("/") && arg.endsWith("/update");
            const isTargetedPageCid = arg === pageCidToFail;
            const currentFailures = failureCountByArg.get(arg) ?? 0;
            if ((isPostUpdateMfsPath || isTargetedPageCid) && currentFailures < FAIL_ATTEMPTS) {
                failureCountByArg.set(arg, currentFailures + 1);
                return (async function* throwFetchFailed(): AsyncGenerator<Uint8Array> {
                    // Match the real CI error shape: undici raises TypeError("fetch failed")
                    // whose `.cause` is an AggregateError bundling the per-address connect
                    // errors (happy-eyeballs tries 127.0.0.1 + ::1 in parallel). See base-
                    // client-manager.ts:_fetchCidP2P's extractNetworkErrorDetails extractor.
                    const ipv4Err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:15001"), {
                        code: "ECONNREFUSED",
                        errno: -111,
                        syscall: "connect",
                        address: "127.0.0.1",
                        port: 15001
                    });
                    const ipv6Err = Object.assign(new Error("connect ECONNREFUSED ::1:15001"), {
                        code: "ECONNREFUSED",
                        errno: -111,
                        syscall: "connect",
                        address: "::1",
                        port: 15001
                    });
                    const aggregate = new AggregateError([ipv4Err, ipv6Err], "");
                    throw Object.assign(new TypeError("fetch failed"), { cause: aggregate });
                    // eslint-disable-next-line no-unreachable
                    yield new Uint8Array();
                })();
            }
            return originalCat(target, opts);
        } as typeof kuboClient.cat;

        // Freeze the publisher's community update loop so it emits NO new IPNS publishes
        // for the duration of the test. In the CI run the publisher naturally went quiet
        // (no new replies, 15-min `lastPublishTooOld` threshold), so the remote PKC had no
        // push events to retry on. We reproduce that deterministically by short-circuiting
        // `updateCommunityIpnsIfNeeded` — whatever other code path sets
        // `_communityUpdateTrigger = true`, the publish is a no-op now so no mirror events fire.
        type WithUpdateIpns = { updateCommunityIpnsIfNeeded: (...args: unknown[]) => Promise<void> };
        const publisherAsPublisher = community as unknown as WithUpdateIpns;
        const originalUpdateCommunityIpns = publisherAsPublisher.updateCommunityIpnsIfNeeded.bind(community);
        publisherAsPublisher.updateCommunityIpnsIfNeeded = async () => {};

        const replyComment = await remotePKC.getComment({ cid: leafCid });
        try {
            await replyComment.update();
            mockReplyToUseParentPagesForUpdates(replyComment);

            // Snapshot the publisher's community state at test start — the fix should keep
            // the publisher in `started` state throughout.
            expect(community.state).toBe("started");

            // 30s budget: a fix that polls on any reasonable cadence (≤ 5s) will comfortably
            // meet this. On master the reply's `updatedAt` never catches up to the stored
            // `expectedLeafUpdate.updatedAt` because the publisher has nothing new to push.
            await resolveWhenConditionIsTrueWithTimeout({
                toUpdate: replyComment,
                predicate: async () => typeof replyComment.updatedAt === "number" && replyComment.updatedAt >= expectedLeafUpdate.updatedAt,
                timeoutMs: 30_000
            });

            expect(replyComment.updatedAt).toBeGreaterThanOrEqual(expectedLeafUpdate.updatedAt);
            expect(replyComment.parentCid).toBe(rootCid);
            expect(community.state).toBe("started");

            // Sanity: confirm the patch actually fired — otherwise this test would pass
            // even on master and give a false "fixed" signal. Each targeted CID was failed
            // FAIL_ATTEMPTS times (by design), so the total recorded failures should be
            // >= FAIL_ATTEMPTS for at least one arg.
            expect(failureCountByArg.size).toBeGreaterThan(0);
            const maxFailures = Math.max(...Array.from(failureCountByArg.values()));
            expect(maxFailures).toBe(FAIL_ATTEMPTS);
        } finally {
            kuboClient.cat = originalCat as typeof kuboClient.cat;
            publisherAsPublisher.updateCommunityIpnsIfNeeded = originalUpdateCommunityIpns;
            await remotePKC.destroy();
        }
    }, 35_000);
});

function extractFirstPageCid(storedUpdate: CommentUpdatesRow): string | undefined {
    const replies = storedUpdate.replies;
    if (!replies) return undefined;
    for (const sortEntry of Object.values(replies)) {
        const allPageCids = (sortEntry as { allPageCids?: string[] } | undefined)?.allPageCids;
        if (allPageCids?.[0]) return allPageCids[0];
    }
    return undefined;
}

async function waitForStoredCommentUpdate(community: LocalCommunity, cid: string): Promise<CommentUpdateType> {
    const timeoutMs = 60_000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const stored = community._dbHandler.queryStoredCommentUpdate({ cid });
        if (stored) return stored as unknown as CommentUpdateType;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for stored comment update for ${cid}`);
}

async function waitForStoredParentPageCids(community: LocalCommunity, parentCid: string): Promise<CommentUpdatesRow> {
    const timeoutMs = 60_000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const storedUpdate = community._dbHandler.queryStoredCommentUpdate({ cid: parentCid });
        const hasPageCids =
            storedUpdate?.replies &&
            Object.values(storedUpdate.replies).some((s) => (s as { allPageCids?: string[] } | undefined)?.allPageCids?.length);
        if (hasPageCids) return storedUpdate!;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for parent comment ${parentCid} to have replies with allPageCids in stored update`);
}

async function resolveWhenConditionIsTrueWithTimeout({
    toUpdate,
    predicate,
    timeoutMs
}: {
    toUpdate: Comment;
    predicate: () => Promise<boolean>;
    timeoutMs: number;
}): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for reply.updatedAt to catch up to publisher's stored update after ${timeoutMs}ms`);
}
